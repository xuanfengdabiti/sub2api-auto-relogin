const crypto = require('crypto');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function encodeBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseJwtPayload(token) {
  if (typeof token !== 'string' || token.trim() === '') return undefined;
  const segments = token.split('.');
  if (segments.length < 2) return undefined;
  try {
    return JSON.parse(decodeBase64Url(segments[1]));
  } catch {
    return undefined;
  }
}

function getOpenAIAuthSection(payload) {
  if (!isPlainObject(payload)) return {};
  const auth = payload['https://api.openai.com/auth'];
  return isPlainObject(auth) ? auth : {};
}

function getOpenAIProfileSection(payload) {
  if (!isPlainObject(payload)) return {};
  const profile = payload['https://api.openai.com/profile'];
  return isPlainObject(profile) ? profile : {};
}

function normalizeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function timestampFromUnixSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function epochSecondsFromValue(value) {
  if (value === undefined || value === null || value === '') return 0;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric);
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
}

function buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt) {
  if (!accountId) return undefined;

  const now = Math.trunc(Date.now() / 1000);
  const authInfo = { chatgpt_account_id: accountId };
  const expires = epochSecondsFromValue(expiresAt) || now + 90 * 24 * 60 * 60;

  if (planType) authInfo.chatgpt_plan_type = planType;
  if (userId) {
    authInfo.chatgpt_user_id = userId;
    authInfo.user_id = userId;
  }

  const payload = {
    iat: now,
    exp: expires,
    'https://api.openai.com/auth': authInfo,
  };
  if (email) payload.email = email;

  return `${encodeBase64UrlJson({ alg: 'none', typ: 'JWT', cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.`;
}

function getExpiresIn(expiresAt, now = new Date()) {
  if (!expiresAt) return undefined;
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return undefined;
  return Math.max(0, Math.floor((expiresMs - now.getTime()) / 1000));
}

function stripUnavailable(value) {
  if (Array.isArray(value)) {
    return value.map(stripUnavailable).filter((item) => item !== undefined);
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripUnavailable(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  if (value === undefined || value === null || value === '') return undefined;
  return value;
}

function toEmailKey(email) {
  if (typeof email !== 'string') return undefined;
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function collectSessionLikeObjects(value, sourceName = 'pasted-json') {
  const found = [];
  const visited = new WeakSet();

  function visit(item, path) {
    if (!isPlainObject(item) && !Array.isArray(item)) return;

    if (isPlainObject(item)) {
      if (visited.has(item)) return;
      visited.add(item);

      const token = firstNonEmpty(
        item.accessToken,
        item.access_token,
        item.token?.accessToken,
        item.token?.access_token,
        item.credentials?.accessToken,
        item.credentials?.access_token,
      );
      const hasIdentity = isPlainObject(item.user) || firstNonEmpty(
        item.email,
        item.name,
        item.providerSpecificData?.chatgptAccountId,
        item.providerSpecificData?.chatgpt_account_id,
        item.id,
      );
      if (token && hasIdentity) {
        found.push({ value: item, sourceName, path });
        return;
      }

      for (const [key, child] of Object.entries(item)) {
        if (key === 'accessToken' || key === 'access_token' || key === 'sessionToken') continue;
        visit(child, `${path}.${key}`);
      }
      return;
    }

    item.forEach((child, index) => visit(child, `${path}[${index}]`));
  }

  visit(value, '$');
  return found;
}

function parseInputDocuments(text, sourceName = 'pasted-json') {
  if (typeof text !== 'string' || text.trim() === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON parse failed: ${error.message}`);
  }

  return collectSessionLikeObjects(parsed, sourceName);
}

function accessTokenHash(accessToken) {
  return crypto.createHash('sha256').update(String(accessToken || ''), 'utf8').digest('hex');
}

function convertSession(record, options = {}) {
  if (!isPlainObject(record)) {
    throw new Error('session is not a JSON object');
  }

  const accessToken = firstNonEmpty(
    record.accessToken,
    record.access_token,
    record.token?.accessToken,
    record.token?.access_token,
    record.credentials?.accessToken,
    record.credentials?.access_token,
  );
  if (!accessToken) throw new Error('missing accessToken');

  const sessionToken = firstNonEmpty(
    record.sessionToken,
    record.session_token,
    record.token?.sessionToken,
    record.token?.session_token,
    record.credentials?.session_token,
  );
  const refreshToken = firstNonEmpty(
    record.refreshToken,
    record.refresh_token,
    record.token?.refreshToken,
    record.token?.refresh_token,
    record.credentials?.refresh_token,
  );
  const inputIdToken = firstNonEmpty(
    record.idToken,
    record.id_token,
    record.token?.idToken,
    record.token?.id_token,
    record.credentials?.id_token,
  );

  const payload = parseJwtPayload(accessToken);
  const idPayload = parseJwtPayload(inputIdToken);
  const auth = getOpenAIAuthSection(payload);
  const idAuth = getOpenAIAuthSection(idPayload);
  const profile = getOpenAIProfileSection(payload);
  const expiresAt = firstNonEmpty(
    payload ? timestampFromUnixSeconds(payload.exp) : undefined,
    normalizeTimestamp(record.expires),
    normalizeTimestamp(record.expiresAt),
    normalizeTimestamp(record.expired),
    normalizeTimestamp(record.expires_at),
  );
  const email = firstNonEmpty(
    record.user?.email,
    record.email,
    record.credentials?.email,
    record.providerSpecificData?.email,
    profile.email,
    idPayload?.email,
    payload?.email,
  );
  const accountId = firstNonEmpty(
    record.account?.id,
    record.account_id,
    record.chatgptAccountId,
    record.providerSpecificData?.chatgptAccountId,
    record.providerSpecificData?.chatgpt_account_id,
    record.credentials?.chatgpt_account_id,
    auth.chatgpt_account_id,
    idAuth.chatgpt_account_id,
    record.provider === 'codex' ? record.id : undefined,
  );
  const userId = firstNonEmpty(
    record.user?.id,
    record.user_id,
    record.chatgptUserId,
    record.providerSpecificData?.chatgptUserId,
    record.providerSpecificData?.chatgpt_user_id,
    record.credentials?.chatgpt_user_id,
    auth.chatgpt_user_id,
    auth.user_id,
    idAuth.chatgpt_user_id,
    idAuth.user_id,
  );
  const planType = firstNonEmpty(
    record.account?.planType,
    record.account?.plan_type,
    record.planType,
    record.plan_type,
    record.providerSpecificData?.chatgptPlanType,
    record.providerSpecificData?.chatgpt_plan_type,
    record.credentials?.plan_type,
    auth.chatgpt_plan_type,
    idAuth.chatgpt_plan_type,
  );
  const exportedAt = normalizeTimestamp(options.now || new Date());
  const expiresIn = getExpiresIn(expiresAt, options.now || new Date());
  const sourceName = firstNonEmpty(options.sourceName, 'pasted-json');
  const sourceType = record.provider === 'codex' && record.authType === 'oauth' ? '9router' : 'chatgpt_web_session';
  const name = firstNonEmpty(options.accountName, email, sourceName, 'ChatGPT Account');
  const syntheticIdToken = !inputIdToken
    ? buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt)
    : undefined;
  const idToken = firstNonEmpty(inputIdToken, syntheticIdToken);

  const cpa = Object.fromEntries(Object.entries({
    type: 'codex',
    account_id: accountId,
    chatgpt_account_id: accountId,
    email,
    name,
    plan_type: planType,
    chatgpt_plan_type: planType,
    id_token: idToken,
    id_token_synthetic: Boolean(syntheticIdToken) || undefined,
    access_token: accessToken,
    refresh_token: refreshToken || '',
    session_token: sessionToken,
    last_refresh: exportedAt,
    expired: expiresAt,
    disabled: Boolean(record.disabled) || undefined,
  }).filter(([, value]) => value !== undefined && value !== null));

  const cockpit = {
    type: 'codex',
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken || '',
    account_id: accountId,
    last_refresh: exportedAt,
    email,
    expired: expiresAt,
    account_note: firstNonEmpty(record.account_note, record.accountInfo, record.account_info, record.note, record.notes, record.remark),
  };

  const sub2apiAccount = stripUnavailable({
    name: firstNonEmpty(options.accountName, name, email, sourceName, 'ChatGPT Account'),
    platform: 'openai',
    type: 'oauth',
    concurrency: Number(options.concurrency || 10),
    priority: Number(options.priority || 1),
    rate_multiplier: Number(options.rateMultiplier || 1),
    credentials: {
      access_token: accessToken,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      email,
      expires_at: expiresAt,
      expires_in: expiresIn,
      plan_type: planType,
    },
    extra: {
      access_token_sha256: accessTokenHash(accessToken),
      email,
      email_key: toEmailKey(email),
      name,
      auth_provider: firstNonEmpty(record.authProvider, record.auth_provider),
      import_source: 'codex_auto_relogin',
      source: sourceType,
      last_refresh: exportedAt,
      session_token_present: Boolean(sessionToken),
    },
    expires_at: epochSecondsFromValue(expiresAt) || undefined,
    auto_pause_on_expired: options.autoPauseOnExpired !== false,
  });

  const priority = Number.isFinite(Number(record.priority)) ? Number(record.priority) : 9;
  const isActive = typeof record.isActive === 'boolean' ? record.isActive : !Boolean(record.disabled);
  const createdAt = normalizeTimestamp(record.createdAt) || exportedAt;
  const updatedAt = normalizeTimestamp(record.updatedAt) || exportedAt;
  const nineRouter = stripUnavailable({
    accessToken,
    refreshToken,
    expiresAt,
    testStatus: firstNonEmpty(record.testStatus, record.test_status, 'active'),
    expiresIn,
    providerSpecificData: {
      chatgptAccountId: accountId,
      chatgptPlanType: planType,
    },
    id: accountId,
    provider: 'codex',
    authType: 'oauth',
    name,
    email,
    priority,
    isActive,
    createdAt,
    updatedAt,
  });

  return {
    sourceName,
    sourcePath: options.sourcePath,
    email,
    name,
    expiresAt,
    cpa,
    cockpit,
    nineRouter,
    sub2apiAccount,
  };
}

function normalizeProxy(proxy) {
  if (!proxy || !isPlainObject(proxy)) return null;
  const protocol = firstNonEmpty(proxy.protocol) || 'http';
  const host = firstNonEmpty(proxy.host);
  const port = Number(proxy.port || 0);
  const username = firstNonEmpty(proxy.username) || '';
  const password = firstNonEmpty(proxy.password) || '';
  const proxyKey = firstNonEmpty(
    proxy.proxy_key,
    proxy.proxyKey,
    host && port ? `${protocol}|${host}|${port}|${username}|${password}` : undefined,
  );
  if (!proxyKey) return null;
  return stripUnavailable({
    proxy_key: proxyKey,
    name: firstNonEmpty(proxy.name, proxyKey),
    protocol,
    host,
    port: port || undefined,
    username,
    password,
    status: firstNonEmpty(proxy.status, 'active'),
  });
}

function pickProxy(referenceDocument, options = {}) {
  const proxies = Array.isArray(referenceDocument?.proxies) ? referenceDocument.proxies : [];
  const proxyName = firstNonEmpty(options.proxyName);
  const proxyKey = firstNonEmpty(options.proxyKey);
  let selected = null;

  if (proxyKey) {
    selected = proxies.find((proxy) => String(proxy?.proxy_key || proxy?.proxyKey || '') === proxyKey);
  }
  if (!selected && proxyName) {
    selected = proxies.find((proxy) => String(proxy?.name || '').toLowerCase() === proxyName.toLowerCase());
  }
  if (!selected && proxies.length === 1) {
    selected = proxies[0];
  }
  if (!selected && options.proxy) {
    selected = options.proxy;
  }
  return normalizeProxy(selected);
}

function applySub2apiDefaults(document, options = {}) {
  const groupName = firstNonEmpty(options.groupName);
  const concurrency = Number(options.concurrency || 10);
  const priority = Number(options.priority || 1);
  const rateMultiplier = Number(options.rateMultiplier || 1);
  const proxy = normalizeProxy(options.proxy);
  const proxyKey = firstNonEmpty(options.proxyKey, proxy?.proxy_key);

  const accounts = (Array.isArray(document?.accounts) ? document.accounts : []).map((account) => {
    const next = {
      ...account,
      concurrency,
      priority,
      rate_multiplier: rateMultiplier,
      auto_pause_on_expired: account.auto_pause_on_expired !== false,
    };
    if (proxyKey) next.proxy_key = proxyKey;
    if (groupName) {
      next.groups = [{ name: groupName }];
      next.group_name = groupName;
    }
    return stripUnavailable(next);
  });

  return stripUnavailable({
    exported_at: document.exported_at || normalizeTimestamp(new Date()),
    proxies: proxy ? [proxy] : (Array.isArray(document.proxies) ? document.proxies : []),
    accounts,
  });
}

function buildSub2apiDocument(converted, options = {}) {
  const now = options.now || new Date();
  const document = {
    exported_at: normalizeTimestamp(now),
    proxies: options.proxy ? [normalizeProxy(options.proxy)].filter(Boolean) : [],
    accounts: converted.map((item) => item.sub2apiAccount),
  };
  return applySub2apiDefaults(document, options);
}

function convertSessionsToSub2api(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [sessions];
  const now = options.now || new Date();
  const converted = [];
  const skipped = [];

  list.forEach((item, index) => {
    try {
      const record = item?.value !== undefined ? item.value : item;
      converted.push(convertSession(record, {
        ...options,
        now,
        sourceName: item?.sourceName || options.sourceName || `session-${index + 1}`,
        sourcePath: item?.path || item?.sourcePath || `$[${index}]`,
      }));
    } catch (error) {
      skipped.push({
        sourceName: item?.sourceName || options.sourceName || `session-${index + 1}`,
        path: item?.path || item?.sourcePath || `$[${index}]`,
        reason: error instanceof Error ? error.message : 'convert failed',
      });
    }
  });

  return {
    converted,
    skipped,
    document: buildSub2apiDocument(converted, { ...options, now }),
  };
}

function convertTextToSub2api(text, options = {}) {
  const sources = parseInputDocuments(text, options.sourceName || 'pasted-json');
  if (!sources.length) {
    return {
      converted: [],
      skipped: [{
        sourceName: options.sourceName || 'pasted-json',
        path: '$',
        reason: 'no session object with accessToken and identity found',
      }],
      document: buildSub2apiDocument([], options),
    };
  }
  return convertSessionsToSub2api(sources, options);
}

function summarizeSub2apiDocument(document) {
  const accounts = Array.isArray(document?.accounts) ? document.accounts : [];
  return {
    exportedAt: document?.exported_at || '',
    proxyCount: Array.isArray(document?.proxies) ? document.proxies.length : 0,
    accountCount: accounts.length,
    accounts: accounts.map((account) => ({
      name: account.name || '',
      email: account.credentials?.email || account.extra?.email || '',
      platform: account.platform || '',
      type: account.type || '',
      concurrency: account.concurrency,
      proxyName: (document.proxies || []).find((proxy) => proxy.proxy_key === account.proxy_key)?.name || '',
      hasProxyKey: Boolean(account.proxy_key),
      groupNames: [
        ...(Array.isArray(account.groups) ? account.groups.map((group) => group?.name).filter(Boolean) : []),
        account.group_name,
      ].filter(Boolean).filter((name, index, list) => list.indexOf(name) === index),
      expiresAt: account.credentials?.expires_at || account.expires_at || '',
      planType: account.credentials?.plan_type || '',
    })),
  };
}

module.exports = {
  applySub2apiDefaults,
  buildSub2apiDocument,
  collectSessionLikeObjects,
  convertSession,
  convertSessionsToSub2api,
  convertTextToSub2api,
  epochSecondsFromValue,
  firstNonEmpty,
  normalizeProxy,
  normalizeTimestamp,
  parseInputDocuments,
  parseJwtPayload,
  pickProxy,
  summarizeSub2apiDocument,
};
