const dns = require('dns/promises');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');
const hotmailUtils = require('../vendor/gujumpgate-v0.1.3-mail/hotmail-utils');
const microsoftEmail = require('../vendor/gujumpgate-v0.1.3-mail/microsoft-email');
const loadedOpenAiMailRulesModule = require('../vendor/gujumpgate-v0.1.3-mail/flows/openai/mail-rules');
const openAiMailRulesModule = loadedOpenAiMailRulesModule?.createOpenAiMailRules
  ? loadedOpenAiMailRulesModule
  : globalThis.MultiPageOpenAiMailRules;
const {
  findAccount,
  loadAccounts,
  updateAccount,
  validateAccount,
} = require('./account-store');

const DEFAULT_MAILBOXES = ['INBOX', 'Junk'];
const DEFAULT_IMAP_HOST = '';
const DEFAULT_IMAP_PORT = 993;

const IPV4_ONLY_HOSTS = new Set([
  'login.microsoftonline.com',
]);

const ipv4Cache = new Map();
const ipv4FetchAgent = new UndiciAgent({
  connect: {
    family: 4,
  },
});

async function resolveIpv4(hostname) {
  const cached = ipv4Cache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.address;
  const addresses = await dns.resolve4(hostname);
  const address = addresses[0];
  if (!address) throw new Error(`No IPv4 address resolved for ${hostname}`);
  ipv4Cache.set(hostname, {
    address,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  return address;
}

async function fetchWithIpv4Fallback(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!IPV4_ONLY_HOSTS.has(url.hostname)) {
    return fetch(input, init);
  }

  try {
    return await fetch(input, init);
  } catch (error) {
    await resolveIpv4(url.hostname);
    return undiciFetch(input, {
      ...init,
      dispatcher: ipv4FetchAgent,
    });
  }
}

function createOpenAiPollPayload(kind = 'login', options = {}) {
  if (!openAiMailRulesModule?.createOpenAiMailRules) {
    throw new Error('OpenAI mail rules module is not available.');
  }
  const rules = openAiMailRulesModule.createOpenAiMailRules({
    getHotmailVerificationRequestTimestamp: () => Number(options.filterAfterTimestamp || 0) || 0,
  });
  const nodeId = kind === 'signup'
    ? openAiMailRulesModule.SIGNUP_CODE_NODE_ID
    : openAiMailRulesModule.LOGIN_CODE_NODE_ID;
  return rules.buildVerificationPollPayloadForNode(nodeId, {
    mailProvider: 'hotmail-api',
    email: options.targetEmail || '',
    step8VerificationTargetEmail: options.targetEmail || '',
  }, options);
}

function normalizeMailboxes(mailboxes = DEFAULT_MAILBOXES) {
  const list = Array.isArray(mailboxes) && mailboxes.length ? mailboxes : DEFAULT_MAILBOXES;
  return [...new Set(list.map((mailbox) => String(mailbox || 'INBOX').trim()).filter(Boolean))];
}

function sortMessagesByTime(messages = []) {
  return messages.slice().sort((left, right) => {
    const leftTime = Date.parse(left?.receivedDateTime || '') || Number(left?.receivedTimestamp || 0) || 0;
    const rightTime = Date.parse(right?.receivedDateTime || '') || Number(right?.receivedTimestamp || 0) || 0;
    return rightTime - leftTime;
  });
}

function normalizeImapMailboxName(value = '') {
  const raw = String(value || 'INBOX').trim() || 'INBOX';
  const lower = raw.toLowerCase().replace(/\s+/g, '');
  if (lower === 'junkemail' || lower === 'junkmail' || lower === 'junk') return 'Junk';
  if (lower === 'inbox') return 'INBOX';
  return raw;
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  const results = [];
  for (const message of messages) {
    const key = [
      message.id,
      message.subject,
      message.from?.emailAddress?.address,
      message.receivedDateTime,
      message.mailbox,
    ].map((item) => String(item || '').trim().toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(message);
  }
  return results;
}

function summarizeMailFetchError(error) {
  const message = String(error?.message || error || '').replace(/\s+/g, ' ').trim();
  if (!message) return 'unknown error';
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

function normalizeImapAddress(addresses = []) {
  const address = Array.isArray(addresses) ? addresses[0] : addresses;
  if (!address) return '';
  if (typeof address === 'string') return address;
  return address.address || address.email || '';
}

function safeDateIso(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : '';
}

function normalizeMailboxAliases(mailboxes = DEFAULT_MAILBOXES) {
  const aliases = [];
  for (const mailbox of normalizeMailboxes(mailboxes)) {
    const normalized = normalizeImapMailboxName(mailbox);
    aliases.push(normalized);
    if (normalized === 'Junk') {
      aliases.push('Junk Email', 'JunkEmail');
    }
  }
  return [...new Set(aliases.map((item) => String(item || '').trim()).filter(Boolean))];
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  return fallback;
}

function normalizeImapProfile(profile = {}, defaults = {}) {
  const host = String(profile.host || defaults.host || '').trim();
  const port = Number(profile.port || defaults.port || 993);
  const secure = profile.secure === undefined
    ? Boolean(defaults.secure)
    : Boolean(profile.secure);
  return {
    name: String(profile.name || defaults.name || host || 'imap').trim(),
    host,
    port,
    secure,
    loginMethod: String(profile.loginMethod || defaults.loginMethod || 'LOGIN').trim() || 'LOGIN',
    rejectUnauthorized: profile.rejectUnauthorized === undefined
      ? defaults.rejectUnauthorized
      : profile.rejectUnauthorized,
  };
}

function getImapProfiles(options = {}) {
  if (Array.isArray(options.imapProfiles) && options.imapProfiles.length) {
    return options.imapProfiles.map((profile) => normalizeImapProfile(profile)).filter((profile) => profile.host);
  }

  const envProfiles = String(process.env.MAIL_IMAP_PROFILES || process.env.SHANYOUXIANG_IMAP_PROFILES || '').trim();
  if (envProfiles) {
    return envProfiles
      .split(',')
      .map((item) => {
        const [nameOrHost, port, secure, loginMethod] = item.split(':');
        return normalizeImapProfile({
          name: nameOrHost,
          host: nameOrHost,
          port,
          secure: secure ? parseBooleanEnv(secure, true) : undefined,
          loginMethod,
        });
      })
      .filter((profile) => profile.host);
  }

  const longTermHost = options.imapHost
    || process.env.MAIL_IMAP_HOST
    || process.env.SHANYOUXIANG_IMAP_HOST
    || DEFAULT_IMAP_HOST;
  const longTermPort = Number(options.imapPort || process.env.MAIL_IMAP_PORT || process.env.SHANYOUXIANG_IMAP_PORT || DEFAULT_IMAP_PORT);
  const longTermSecure = options.imapSecure === undefined
    ? parseBooleanEnv(process.env.MAIL_IMAP_SECURE ?? process.env.SHANYOUXIANG_IMAP_SECURE, true)
    : options.imapSecure !== false;

  const profiles = [
    normalizeImapProfile({
      name: process.env.MAIL_IMAP_NAME || 'imap-primary',
      host: longTermHost,
      port: longTermPort,
      secure: longTermSecure,
      loginMethod: process.env.MAIL_IMAP_LOGIN_METHOD || process.env.SHANYOUXIANG_IMAP_LOGIN_METHOD || 'LOGIN',
      rejectUnauthorized: parseBooleanEnv(process.env.MAIL_IMAP_REJECT_UNAUTHORIZED, undefined),
    }),
  ];

  if (process.env.SHANYOUXIANG_FRESH_IMAP_HOST || process.env.MAIL_IMAP_FALLBACK_HOST) {
    profiles.push(
      normalizeImapProfile({
        name: process.env.MAIL_IMAP_FALLBACK_NAME || 'imap-fallback',
        host: process.env.MAIL_IMAP_FALLBACK_HOST || process.env.SHANYOUXIANG_FRESH_IMAP_HOST,
        port: Number(process.env.MAIL_IMAP_FALLBACK_PORT || process.env.SHANYOUXIANG_FRESH_IMAP_PORT || 143),
        secure: parseBooleanEnv(process.env.MAIL_IMAP_FALLBACK_SECURE ?? process.env.SHANYOUXIANG_FRESH_IMAP_SECURE, false),
        loginMethod: process.env.MAIL_IMAP_FALLBACK_LOGIN_METHOD || process.env.SHANYOUXIANG_FRESH_IMAP_LOGIN_METHOD || 'AUTH=PLAIN',
        rejectUnauthorized: parseBooleanEnv(
          process.env.MAIL_IMAP_FALLBACK_REJECT_UNAUTHORIZED ?? process.env.SHANYOUXIANG_FRESH_IMAP_REJECT_UNAUTHORIZED,
          true
        ),
      })
    );
  }

  return profiles.filter((profile) => profile.host);
}

function imapTransportName(profile) {
  return `imap:${profile.name}`;
}

async function resolveExistingImapMailboxes(client, requestedMailboxes) {
  const requested = normalizeMailboxAliases(requestedMailboxes);
  let listed = [];
  try {
    listed = await client.list();
  } catch (_) {
    listed = [];
  }

  if (!listed.length) return requested;

  const byLowerPath = new Map();
  const byLowerName = new Map();
  const bySpecialUse = new Map();
  for (const item of listed) {
    const path = String(item.path || item.pathAsListed || '').trim();
    const name = String(item.name || '').trim();
    if (path) byLowerPath.set(path.toLowerCase(), path);
    if (name && path) byLowerName.set(name.toLowerCase(), path);
    if (item.specialUse && path) bySpecialUse.set(String(item.specialUse).toLowerCase(), path);
  }

  const resolved = [];
  for (const mailbox of requested) {
    const lower = mailbox.toLowerCase();
    const special = lower === 'inbox'
      ? '\\inbox'
      : (lower.includes('junk') ? '\\junk' : '');
    const path = byLowerPath.get(lower)
      || byLowerName.get(lower)
      || (special ? bySpecialUse.get(special) : '')
      || mailbox;
    if (!resolved.includes(path)) resolved.push(path);
  }
  return resolved.length ? resolved : requested;
}

async function normalizeImapMessage(rawMessage, mailbox) {
  const parsed = rawMessage.source ? await simpleParser(rawMessage.source) : null;
  const fromAddress = normalizeImapAddress(rawMessage.envelope?.from)
    || normalizeImapAddress(parsed?.from?.value);
  const recipients = {
    to: (parsed?.to?.value || rawMessage.envelope?.to || []).map((item) => item.address || '').filter(Boolean),
    cc: (parsed?.cc?.value || rawMessage.envelope?.cc || []).map((item) => item.address || '').filter(Boolean),
    bcc: (parsed?.bcc?.value || rawMessage.envelope?.bcc || []).map((item) => item.address || '').filter(Boolean),
  };
  recipients.all = [...new Set([...recipients.to, ...recipients.cc, ...recipients.bcc])];

  const receivedDate = rawMessage.internalDate
    || rawMessage.envelope?.date
    || parsed?.date
    || '';
  const text = [
    parsed?.text,
    parsed?.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '',
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  return {
    id: String(rawMessage.uid || parsed?.messageId || `${mailbox}-${receivedDate || ''}`),
    subject: String(parsed?.subject || rawMessage.envelope?.subject || ''),
    from: {
      emailAddress: {
        address: fromAddress,
      },
    },
    bodyPreview: text.slice(0, 5000),
    receivedDateTime: safeDateIso(receivedDate),
    recipients,
    mailbox,
    transport: 'imap',
  };
}

async function fetchImapProfileMessages(account, profile, options = {}) {
  const client = new ImapFlow({
    host: profile.host,
    port: profile.port,
    secure: profile.secure,
    auth: {
      user: account.email,
      pass: account.password,
      loginMethod: profile.loginMethod,
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: Number(options.connectionTimeout || 15000),
    greetingTimeout: Number(options.greetingTimeout || 15000),
    socketTimeout: Number(options.socketTimeout || 30000),
    tls: {
      servername: profile.host,
      ...(profile.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: profile.rejectUnauthorized }),
    },
  });

  const top = Math.max(1, Math.min(Number(options.top) || 5, 30));
  const messages = [];
  const mailboxResults = [];

  try {
    await client.connect();
    const mailboxes = await resolveExistingImapMailboxes(client, options.mailboxes || DEFAULT_MAILBOXES);
    const seenMailboxKeys = new Set();
    for (const mailbox of mailboxes) {
      const mailboxKey = String(mailbox || '').trim().toLowerCase();
      if (seenMailboxKeys.has(mailboxKey)) continue;
      seenMailboxKeys.add(mailboxKey);
      let lock = null;
      try {
        lock = await client.getMailboxLock(mailbox);
        const exists = Number(client.mailbox?.exists || 0);
        const count = Math.min(top, exists);
        const range = count > 0 ? `${Math.max(1, exists - count + 1)}:*` : '';
        const mailboxMessages = [];
        if (range) {
          for await (const message of client.fetch(range, {
            uid: true,
            envelope: true,
            internalDate: true,
            source: {
              maxLength: 256 * 1024,
            },
          })) {
            mailboxMessages.push(await normalizeImapMessage(message, mailbox));
          }
        }
        messages.push(...mailboxMessages);
        mailboxResults.push({
          mailbox,
          count: mailboxMessages.length,
          transport: imapTransportName(profile),
          tokenStrategy: 'password-imap',
        });
      } catch (error) {
        mailboxResults.push({
          mailbox,
          count: 0,
          transport: imapTransportName(profile),
          tokenStrategy: 'password-imap',
          error: summarizeMailFetchError(error),
        });
      } finally {
        if (lock) lock.release();
      }
    }
    if (mailboxResults.length && mailboxResults.every((result) => result.error)) {
      throw new Error(`IMAP mailbox fetch failed: ${mailboxResults.map((result) => `${result.mailbox}: ${result.error}`).join('; ')}`);
    }
  } finally {
    try {
      await client.logout();
    } catch (_) {
      // Connection may already be closed after authentication or network failures.
    }
  }

  return {
    messages: sortMessagesByTime(dedupeMessages(messages)),
    mailboxResults,
    tokenMeta: {
      tokenStrategy: 'password-imap',
      transport: imapTransportName(profile),
    },
  };
}

async function fetchConfiguredImapMessages(account, options = {}) {
  if (!account.password) {
    throw new Error(`Hotmail account ${account.email} is missing password for IMAP.`);
  }

  const errors = [];
  for (const profile of getImapProfiles(options)) {
    try {
      return await fetchImapProfileMessages(account, profile, options);
    } catch (error) {
      const summary = summarizeMailFetchError(error);
      errors.push(`${profile.name}(${profile.host}:${profile.port}/${profile.secure ? 'tls' : 'plain'}): ${summary}`);
      if (typeof options.log === 'function') {
        options.log(`IMAP profile ${profile.name} failed for ${account.email}: ${summary}`);
      }
    }
  }

  throw new Error(`IMAP request failed: ${errors.join(' | ')}`);
}

const fetchShanyouxiangImapMessages = fetchConfiguredImapMessages;

function resolveAccount(identifier = '') {
  const accounts = loadAccounts();
  if (identifier) {
    const account = findAccount(identifier, accounts);
    if (!account) throw new Error(`Hotmail account not found: ${identifier}`);
    return account;
  }
  const preferred = accounts.find((account) => account.status === 'authorized' && account.refreshToken)
    || accounts.find((account) => account.refreshToken)
    || accounts[0];
  if (!preferred) {
    throw new Error('No Hotmail accounts are saved. Run import first.');
  }
  return preferred;
}

async function fetchMicrosoftGraphMessages(account, options = {}) {
  if (!account.clientId || !account.refreshToken) {
    throw new Error(`Hotmail account ${account.email} is missing token credentials for Graph.`);
  }
  let workingRefreshToken = account.refreshToken;
  const mailboxes = normalizeMailboxes(options.mailboxes);
  const top = Math.max(1, Math.min(Number(options.top) || 5, 30));
  const messages = [];
  const mailboxResults = [];
  let lastTokenMeta = null;

  for (const mailbox of mailboxes) {
    const result = await microsoftEmail.fetchMicrosoftMailboxMessages({
      clientId: account.clientId,
      refreshToken: workingRefreshToken,
      mailbox,
      top,
      fetchImpl: options.fetchImpl || fetchWithIpv4Fallback,
      signal: options.signal,
      log: options.log,
    });
    if (result.nextRefreshToken) {
      workingRefreshToken = result.nextRefreshToken;
    }
    lastTokenMeta = {
      tokenStrategy: result.tokenStrategy,
      transport: result.transport,
    };
    const normalizedMessages = hotmailUtils.normalizeHotmailMailApiMessages(result.messages)
      .map((message) => ({
        ...message,
        mailbox: message.mailbox || mailbox,
      }));
    messages.push(...normalizedMessages);
    mailboxResults.push({
      mailbox,
      count: normalizedMessages.length,
      transport: result.transport,
      tokenStrategy: result.tokenStrategy,
    });
  }

  if (workingRefreshToken && workingRefreshToken !== account.refreshToken) {
    updateAccount(account.id, {
      refreshToken: workingRefreshToken,
      status: 'authorized',
      lastAuthAt: Date.now(),
      lastError: '',
    });
  } else {
    updateAccount(account.id, {
      status: 'authorized',
      lastAuthAt: Date.now(),
      lastError: '',
    });
  }

  return {
    account: {
      ...account,
      refreshToken: workingRefreshToken || account.refreshToken,
      status: 'authorized',
      lastAuthAt: Date.now(),
      lastError: '',
    },
    messages: sortMessagesByTime(messages),
    mailboxResults,
    tokenMeta: lastTokenMeta,
  };
}

async function fetchMailboxMessages(accountInput, options = {}) {
  const account = typeof accountInput === 'string' || !accountInput
    ? resolveAccount(accountInput || options.account)
    : accountInput;
  validateAccount(account);

  const preferImap = String(options.transport || process.env.MAIL_FETCH_TRANSPORT || '').toLowerCase() === 'imap';
  const canUseGraph = Boolean(account.clientId && account.refreshToken);
  const canUseImap = Boolean(account.password);
  let graphError = null;

  if (canUseGraph && !preferImap) {
    try {
      return await fetchMicrosoftGraphMessages(account, options);
    } catch (error) {
      graphError = error;
      if (!canUseImap) throw error;
      if (typeof options.log === 'function') {
        options.log(`Graph mailbox fetch failed for ${account.email}; using IMAP fallback: ${summarizeMailFetchError(error)}`);
      }
    }
  }

  if (!canUseImap) {
    throw graphError || new Error(`Hotmail account ${account.email} is missing password for IMAP.`);
  }

  const imapResult = await fetchConfiguredImapMessages(account, options);
  const lastError = graphError
    ? `Graph failed; IMAP ok: ${summarizeMailFetchError(graphError)}`
    : '';
  updateAccount(account.id, {
    status: 'authorized',
    lastAuthAt: Date.now(),
    lastError,
  });
  return {
    account: {
      ...account,
      status: 'authorized',
      lastAuthAt: Date.now(),
      lastError,
    },
    messages: imapResult.messages,
    mailboxResults: imapResult.mailboxResults,
    tokenMeta: imapResult.tokenMeta,
  };
}

async function checkAccount(identifier = '', options = {}) {
  const account = resolveAccount(identifier);
  try {
    const result = await fetchMailboxMessages(account, {
      ...options,
      mailboxes: options.mailboxes || ['INBOX'],
      top: options.top || 5,
    });
    const latestMessage = hotmailUtils.getLatestHotmailMessage(result.messages);
    const latestCode = latestMessage
      ? hotmailUtils.extractVerificationCodeFromMessage(latestMessage, {
        codePatterns: options.codePatterns,
      })
      : '';
    return {
      ok: true,
      account: result.account,
      messageCount: result.messages.length,
      mailboxResults: result.mailboxResults,
      latestMessage,
      latestCode: latestCode || '',
      tokenMeta: result.tokenMeta,
    };
  } catch (error) {
    updateAccount(account.id, {
      status: 'error',
      lastError: error.message,
    });
    return {
      ok: false,
      account: {
        ...account,
        status: 'error',
        lastError: error.message,
      },
      error: error.message,
    };
  }
}

async function getLatestVerificationCode(identifier = '', options = {}) {
  const account = resolveAccount(identifier);
  const kind = options.kind || 'login';
  const payload = {
    ...createOpenAiPollPayload(kind, {
      targetEmail: account.email,
      filterAfterTimestamp: Number(options.filterAfterTimestamp || 0) || 0,
    }),
    ...(options || {}),
  };
  const result = await fetchMailboxMessages(account, {
    ...options,
    mailboxes: options.mailboxes || DEFAULT_MAILBOXES,
    top: options.top || 10,
  });
  const matchResult = hotmailUtils.pickVerificationMessageWithTimeFallback(result.messages, {
    afterTimestamp: payload.filterAfterTimestamp || 0,
    senderFilters: payload.senderFilters || [],
    subjectFilters: payload.subjectFilters || [],
    requiredKeywords: payload.requiredKeywords || [],
    codePatterns: payload.codePatterns || [],
    excludeCodes: payload.excludeCodes || [],
  });
  const match = matchResult.match;
  if (!match?.code) {
    return {
      ok: false,
      account: result.account,
      messages: result.messages,
      mailboxResults: result.mailboxResults,
      error: 'No matching verification code found.',
    };
  }
  return {
    ok: true,
    account: result.account,
    code: match.code,
    message: match.message,
    emailTimestamp: match.receivedAt || Date.now(),
    usedTimeFallback: matchResult.usedTimeFallback,
    usedRelaxedFilters: matchResult.usedRelaxedFilters,
    mailboxResults: result.mailboxResults,
  };
}

module.exports = {
  DEFAULT_MAILBOXES,
  checkAccount,
  createOpenAiPollPayload,
  fetchMailboxMessages,
  getLatestVerificationCode,
  resolveAccount,
};
