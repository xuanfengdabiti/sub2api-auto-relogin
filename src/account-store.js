const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data', 'mail');
const DEFAULT_RAW_STORAGE_PATH = path.join(
  ROOT_DIR,
  'data',
  'gujumpgate-current-storage',
  'storage-extract-raw.local-only.json'
);
const ACCOUNT_STORE_PATH = path.join(DATA_DIR, 'hotmail-accounts.local.json');
const SETTINGS_STORE_PATH = path.join(DATA_DIR, 'gujumpgate-settings.local.json');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeAccount(raw = {}) {
  const email = normalizeString(raw.email);
  return {
    id: normalizeString(raw.id) || crypto.randomUUID(),
    email,
    password: String(raw.password || ''),
    clientId: normalizeString(raw.clientId),
    refreshToken: normalizeString(raw.refreshToken),
    status: normalizeString(raw.status) || 'pending',
    used: Boolean(raw.used),
    lastAuthAt: Number(raw.lastAuthAt || 0) || 0,
    lastUsedAt: Number(raw.lastUsedAt || 0) || 0,
    lastError: String(raw.lastError || ''),
    gptStatus: normalizeString(raw.gptStatus),
    gptBannedAt: normalizeString(raw.gptBannedAt),
    gptBannedReason: String(raw.gptBannedReason || ''),
    source: normalizeString(raw.source) || 'local',
  };
}

function validateAccount(account) {
  if (!account.email) {
    throw new Error('Hotmail account email is required.');
  }
  const hasPassword = Boolean(account.password);
  const hasClientId = Boolean(account.clientId);
  const hasRefreshToken = Boolean(account.refreshToken);
  if (!hasPassword && !hasClientId && !hasRefreshToken) {
    throw new Error(`Hotmail account ${account.email} is missing password or token credentials.`);
  }
  if (hasRefreshToken && !hasClientId) {
    throw new Error(`Hotmail account ${account.email} is missing clientId.`);
  }
  if (hasClientId && !hasRefreshToken) {
    throw new Error(`Hotmail account ${account.email} is missing refreshToken.`);
  }
}

function looksLikeClientId(value) {
  const text = normalizeString(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    || /^app_[A-Za-z0-9_-]{8,}$/i.test(text);
}

function looksLikeRefreshToken(value) {
  const text = normalizeString(value);
  return text.length > 80
    || /^M\./i.test(text)
    || /^0\./.test(text)
    || /^eyJ/i.test(text);
}

function resolveTokenFields(third, rest) {
  const thirdField = normalizeString(third);
  const fourthField = rest.join('--').trim();
  if (looksLikeRefreshToken(thirdField) && looksLikeClientId(fourthField)) {
    return {
      clientId: fourthField,
      refreshToken: thirdField,
      format: 'email-password-refreshToken-clientId',
    };
  }
  if (looksLikeClientId(thirdField) && looksLikeRefreshToken(fourthField)) {
    return {
      clientId: thirdField,
      refreshToken: fourthField,
      format: 'email-password-clientId-refreshToken',
    };
  }
  return {
    clientId: thirdField,
    refreshToken: fourthField,
    format: 'email-password-clientId-refreshToken',
  };
}

function parseHotmailAccountLine(line, options = {}) {
  const text = normalizeString(line);
  if (!text) return null;
  if (!options.allowComment && /^#/.test(text)) return null;

  const parts = text.split(/\s*-{2,}\s*/).map((part) => part.trim());
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (!options.allowHeader && lowerParts.length >= 4 && lowerParts[2] === 'id' && lowerParts[3] === 'token') {
    return null;
  }
  if (parts.length < 2) {
    throw new Error('Hotmail line must be: email--password or email--password--clientId--refreshToken.');
  }

  const [email, password, thirdField = '', ...tokenParts] = parts;
  if (parts.length === 3) {
    throw new Error('Hotmail line with token credentials must include both clientId and refreshToken.');
  }
  const tokenFields = parts.length >= 4
    ? resolveTokenFields(thirdField, tokenParts)
    : { clientId: '', refreshToken: '', format: 'email-password' };
  const account = normalizeAccount({
    email,
    password,
    clientId: tokenFields.clientId,
    refreshToken: tokenFields.refreshToken,
    status: options.status || 'pending',
    source: options.source || 'manual-line',
  });
  validateAccount(account);
  return account;
}

function parseHotmailAccountLines(rawText, options = {}) {
  const lines = String(rawText || '').split(/\r?\n/);
  const accounts = [];
  const errors = [];

  lines.forEach((line, index) => {
    const trimmed = normalizeString(line);
    if (!trimmed || /^#/.test(trimmed)) return;
    try {
      const account = parseHotmailAccountLine(trimmed, options);
      if (account) accounts.push(account);
    } catch (error) {
      errors.push({
        line: index + 1,
        error: error.message,
      });
    }
  });

  return { accounts, errors };
}

function loadAccounts() {
  return (readJson(ACCOUNT_STORE_PATH, []) || []).map(normalizeAccount);
}

function saveAccounts(accounts) {
  const normalized = (Array.isArray(accounts) ? accounts : []).map(normalizeAccount);
  writeJsonAtomic(ACCOUNT_STORE_PATH, normalized);
  return normalized;
}

function findAccount(identifier, accounts = loadAccounts()) {
  const query = normalizeEmail(identifier);
  if (!query) return null;
  return accounts.find((account) => (
    normalizeEmail(account.id) === query
    || normalizeEmail(account.email) === query
  )) || null;
}

function upsertAccount(input) {
  const nextAccount = normalizeAccount(input);
  validateAccount(nextAccount);
  const accounts = loadAccounts();
  const index = accounts.findIndex((account) => (
    normalizeEmail(account.id) === normalizeEmail(nextAccount.id)
    || normalizeEmail(account.email) === normalizeEmail(nextAccount.email)
  ));
  if (index === -1) {
    accounts.push(nextAccount);
  } else {
    accounts[index] = {
      ...accounts[index],
      ...nextAccount,
      id: accounts[index].id || nextAccount.id,
    };
  }
  saveAccounts(accounts);
  return findAccount(nextAccount.email, accounts);
}

function updateAccount(identifier, updates = {}) {
  const accounts = loadAccounts();
  const index = accounts.findIndex((account) => (
    normalizeEmail(account.id) === normalizeEmail(identifier)
    || normalizeEmail(account.email) === normalizeEmail(identifier)
  ));
  if (index === -1) {
    throw new Error(`Hotmail account not found: ${identifier}`);
  }
  accounts[index] = normalizeAccount({
    ...accounts[index],
    ...updates,
    id: accounts[index].id,
    email: accounts[index].email,
  });
  saveAccounts(accounts);
  return accounts[index];
}

function deleteAccount(identifier) {
  const query = normalizeEmail(identifier);
  if (!query) throw new Error('Hotmail account identifier is required.');
  const accounts = loadAccounts();
  const nextAccounts = accounts.filter((account) => (
    normalizeEmail(account.id) !== query
    && normalizeEmail(account.email) !== query
  ));
  const deleted = accounts.length - nextAccounts.length;
  if (!deleted) {
    return { deleted: 0, accounts: accounts.map(summarizeAccount) };
  }
  saveAccounts(nextAccounts);
  return {
    deleted,
    accounts: accounts
      .filter((account) => normalizeEmail(account.id) === query || normalizeEmail(account.email) === query)
      .map(summarizeAccount),
  };
}

function importFromGuJumpgateStorage(rawStoragePath = DEFAULT_RAW_STORAGE_PATH) {
  const raw = readJson(rawStoragePath, null);
  if (!raw || typeof raw !== 'object') {
    throw new Error(`GuJumpgate storage file is missing or invalid: ${rawStoragePath}`);
  }
  const accounts = (Array.isArray(raw.hotmailAccounts) ? raw.hotmailAccounts : [])
    .map((account) => normalizeAccount({
      ...account,
      source: 'gujumpgate-storage',
    }));
  saveAccounts(accounts);

  const settings = {};
  for (const key of Object.keys(raw).sort()) {
    if (key === 'hotmailAccounts' || key === 'accountRunHistory') continue;
    settings[key] = raw[key];
  }
  writeJsonAtomic(SETTINGS_STORE_PATH, settings);

  return {
    accounts,
    settings,
    accountStorePath: ACCOUNT_STORE_PATH,
    settingsStorePath: SETTINGS_STORE_PATH,
  };
}

function importFromGuJumpgateStorageMerge(rawStoragePath = DEFAULT_RAW_STORAGE_PATH) {
  const raw = readJson(rawStoragePath, null);
  if (!raw || typeof raw !== 'object') {
    throw new Error(`GuJumpgate storage file is missing or invalid: ${rawStoragePath}`);
  }
  const imported = (Array.isArray(raw.hotmailAccounts) ? raw.hotmailAccounts : [])
    .map((account) => normalizeAccount({
      ...account,
      source: 'gujumpgate-storage',
    }));
  const accounts = loadAccounts();
  let added = 0;
  let updated = 0;

  for (const nextAccount of imported) {
    validateAccount(nextAccount);
    const index = accounts.findIndex((account) => (
      normalizeEmail(account.id) === normalizeEmail(nextAccount.id)
      || normalizeEmail(account.email) === normalizeEmail(nextAccount.email)
    ));
    if (index === -1) {
      accounts.push(nextAccount);
      added += 1;
    } else {
      accounts[index] = {
        ...accounts[index],
        ...nextAccount,
        id: accounts[index].id || nextAccount.id,
      };
      updated += 1;
    }
  }

  saveAccounts(accounts);
  return {
    added,
    updated,
    imported: imported.length,
    accounts,
    accountStorePath: ACCOUNT_STORE_PATH,
  };
}

function importFromHotmailAccountLines(rawText, options = {}) {
  const parsed = parseHotmailAccountLines(rawText, {
    ...options,
    source: options.source || 'manual-lines',
  });
  const accounts = loadAccounts();
  let added = 0;
  let updated = 0;

  for (const nextAccount of parsed.accounts) {
    const index = accounts.findIndex((account) => (
      normalizeEmail(account.id) === normalizeEmail(nextAccount.id)
      || normalizeEmail(account.email) === normalizeEmail(nextAccount.email)
    ));
    if (index === -1) {
      accounts.push(nextAccount);
      added += 1;
    } else {
      accounts[index] = {
        ...accounts[index],
        ...nextAccount,
        id: accounts[index].id || nextAccount.id,
      };
      updated += 1;
    }
  }

  if (added || updated) saveAccounts(accounts);
  return {
    added,
    updated,
    imported: parsed.accounts.length,
    errors: parsed.errors,
    accounts,
    accountStorePath: ACCOUNT_STORE_PATH,
  };
}

function importFromHotmailAccountLineFile(filePath, options = {}) {
  const inputPath = path.resolve(filePath);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Hotmail account line file not found: ${inputPath}`);
  }
  return {
    ...importFromHotmailAccountLines(fs.readFileSync(inputPath, 'utf8'), {
      ...options,
      source: options.source || 'manual-line-file',
    }),
    inputPath,
  };
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '***';
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

function maskEmail(value) {
  const text = String(value || '');
  const [local, domain] = text.split('@');
  if (!domain) return maskSecret(text);
  const maskedLocal = local.length <= 3
    ? `${local.slice(0, 1)}**`
    : `${local.slice(0, 3)}***${local.slice(-2)}`;
  return `${maskedLocal}@${domain}`;
}

function summarizeAccount(account) {
  return {
    id: account.id,
    email: maskEmail(account.email),
    status: account.status,
    used: account.used,
    hasPassword: Boolean(account.password),
    hasClientId: Boolean(account.clientId),
    hasRefreshToken: Boolean(account.refreshToken),
    lastAuthAt: account.lastAuthAt,
    lastUsedAt: account.lastUsedAt,
    lastError: account.lastError ? String(account.lastError).slice(0, 200) : '',
    gptStatus: account.gptStatus,
    gptBannedAt: account.gptBannedAt,
    gptBannedReason: account.gptBannedReason ? String(account.gptBannedReason).slice(0, 200) : '',
    source: account.source,
  };
}

module.exports = {
  ACCOUNT_STORE_PATH,
  DEFAULT_RAW_STORAGE_PATH,
  SETTINGS_STORE_PATH,
  deleteAccount,
  findAccount,
  importFromGuJumpgateStorage,
  importFromGuJumpgateStorageMerge,
  importFromHotmailAccountLineFile,
  importFromHotmailAccountLines,
  loadAccounts,
  maskEmail,
  maskSecret,
  normalizeAccount,
  parseHotmailAccountLine,
  parseHotmailAccountLines,
  saveAccounts,
  summarizeAccount,
  updateAccount,
  upsertAccount,
  validateAccount,
};
