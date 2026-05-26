const fs = require('fs/promises');
const fsSync = require('fs');
const dns = require('dns');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env.local');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_PATH = path.join(DATA_DIR, 'sub2api-fail-monitor-state.json');
const LOG_PATH = path.join(DATA_DIR, 'sub2api-fail-monitor.log');
const LOCK_PATH = path.join(DATA_DIR, 'auto-relogin.lock');
const LEGACY_LOCK_PATH = path.join(DATA_DIR, 'sub2api-fail-monitor.lock');
const CONTROL_PATH = path.join(DATA_DIR, 'auto-relogin-control.json');
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

dns.setDefaultResultOrder('ipv4first');

function timeZone() {
  return process.env.TZ || process.env.LOG_TIME_ZONE || DEFAULT_TIME_ZONE;
}

function formatLocalIso(date = new Date(), zone = timeZone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} +08:00`;
}

function nowBeijingIso() {
  return formatLocalIso(new Date(), DEFAULT_TIME_ZONE);
}

function formatBeijingIso(date = new Date()) {
  return formatLocalIso(date, DEFAULT_TIME_ZONE);
}

function parseEnv(content) {
  const env = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadConfig() {
  let fileEnv = {};
  try {
    fileEnv = parseEnv(await fs.readFile(ENV_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const config = {
    url: process.env.SUB2API_URL || fileEnv.SUB2API_URL || '',
    email: process.env.SUB2API_EMAIL || fileEnv.SUB2API_EMAIL || '',
    password: process.env.SUB2API_PASSWORD || fileEnv.SUB2API_PASSWORD || '',
    intervalMinutes: Number(process.env.SUB2API_POLL_INTERVAL_MINUTES || fileEnv.SUB2API_POLL_INTERVAL_MINUTES || 30),
    platform: process.env.SUB2API_ACCOUNT_PLATFORM || fileEnv.SUB2API_ACCOUNT_PLATFORM || 'openai',
    type: process.env.SUB2API_ACCOUNT_TYPE || fileEnv.SUB2API_ACCOUNT_TYPE || 'oauth',
    groupNames: normalizeCsvList(process.env.SUB2API_GROUP_NAMES || fileEnv.SUB2API_GROUP_NAMES || fileEnv.SUB2API_GROUP_NAME || ''),
    proxyName: process.env.SUB2API_PROXY_NAME || fileEnv.SUB2API_PROXY_NAME || '',
    concurrency: Number(process.env.SUB2API_ACCOUNT_CONCURRENCY || fileEnv.SUB2API_ACCOUNT_CONCURRENCY || 10),
    priority: Number(process.env.SUB2API_ACCOUNT_PRIORITY || fileEnv.SUB2API_ACCOUNT_PRIORITY || 1),
    rateMultiplier: Number(process.env.SUB2API_ACCOUNT_RATE_MULTIPLIER || fileEnv.SUB2API_ACCOUNT_RATE_MULTIPLIER || 1),
  };

  const missing = [];
  if (!config.url) missing.push('SUB2API_URL');
  if (!config.email) missing.push('SUB2API_EMAIL');
  if (!config.password) missing.push('SUB2API_PASSWORD');
  if (!config.groupNames.length) missing.push('SUB2API_GROUP_NAMES');
  if (missing.length) {
    throw new Error(`Missing config: ${missing.join(', ')}. Fill ${ENV_PATH}.`);
  }
  if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes <= 0) {
    config.intervalMinutes = 30;
  }
  if (!Number.isFinite(config.concurrency) || config.concurrency <= 0) {
    config.concurrency = 10;
  }
  if (!Number.isFinite(config.priority) || config.priority <= 0) {
    config.priority = 1;
  }
  if (!Number.isFinite(config.rateMultiplier) || config.rateMultiplier <= 0) {
    config.rateMultiplier = 1;
  }
  return config;
}

function normalizeCsvList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getOrigin(rawUrl) {
  const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  return new URL(withProtocol).origin;
}

function getPayloadMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  return payload.message || payload.detail || payload.error || payload.reason || fallback;
}

async function requestJson(origin, requestPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const response = await fetch(`${origin}${requestPath}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'code')) {
      if (Number(payload.code) === 0) return payload.data;
      throw new Error(getPayloadMessage(payload, `SUB2API request failed: HTTP ${response.status} ${requestPath}`));
    }
    if (!response.ok) {
      throw new Error(getPayloadMessage(payload, `SUB2API request failed: HTTP ${response.status} ${requestPath}`));
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`SUB2API request timed out: ${requestPath}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function login(config) {
  const origin = getOrigin(config.url);
  const data = await requestJson(origin, '/api/v1/auth/login', {
    method: 'POST',
    body: { email: config.email, password: config.password },
  });
  const token = String(data?.access_token || data?.accessToken || '').trim();
  if (!token) throw new Error('SUB2API login did not return access_token.');
  return { origin, token };
}

function extractItems(payload) {
  if (Array.isArray(payload)) return { items: payload, total: payload.length, pages: 1 };
  if (Array.isArray(payload?.items)) {
    return {
      items: payload.items,
      total: Number(payload.total) || payload.items.length,
      pages: Math.max(1, Number(payload.pages) || 1),
    };
  }
  return { items: [], total: 0, pages: 1 };
}

async function listFailedAccounts(origin, token, config) {
  const pageSize = 1000;
  const all = [];
  let total = 0;
  let pages = 1;

  for (let page = 1; page <= pages; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      platform: config.platform,
      type: config.type,
      status: 'error',
      sort_by: 'name',
      sort_order: 'asc',
    });
    const payload = await requestJson(origin, `/api/v1/admin/accounts?${params}`, { token });
    const extracted = extractItems(payload);
    all.push(...extracted.items);
    total = extracted.total;
    pages = extracted.pages;
  }

  return {
    accounts: all.filter((account) => (
      String(account?.status || '').toLowerCase() === 'error'
      && accountMatchesGroups(account, config.groupNames)
    )),
    total,
  };
}

async function listGroups(origin, token, platform = '') {
  const query = platform ? `?${new URLSearchParams({ platform })}` : '';
  const payload = await requestJson(origin, `/api/v1/admin/groups/all${query}`, { token });
  return Array.isArray(payload) ? payload : [];
}

async function listProxies(origin, token) {
  const payload = await requestJson(origin, '/api/v1/admin/proxies/all', { token });
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

async function listAllProxies(origin, token) {
  const pageSize = 1000;
  const all = [];
  let pages = 1;

  for (let page = 1; page <= pages; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      sort_by: 'name',
      sort_order: 'asc',
    });
    const payload = await requestJson(origin, `/api/v1/admin/proxies?${params}`, { token });
    const extracted = extractItems(payload);
    all.push(...extracted.items);
    pages = extracted.pages;
  }

  return all;
}

async function resolveGroupIds(origin, token, groupNames = [], platform = '') {
  const groups = await listGroups(origin, token, platform);
  const targets = normalizeCsvList(groupNames).map((name) => name.toLowerCase());
  if (!targets.length) return [];
  const ids = groups
    .filter((group) => targets.includes(String(group?.name || '').trim().toLowerCase()))
    .map((group) => Number(group.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const missing = targets.filter((name) => !groups.some((group) => String(group?.name || '').trim().toLowerCase() === name));
  if (missing.length) {
    throw new Error(`SUB2API group not found: ${missing.join(', ')}`);
  }
  return [...new Set(ids)];
}

async function resolveProxy(origin, token, proxyName = '') {
  const proxies = await listProxies(origin, token);
  const target = String(proxyName || '').trim().toLowerCase();
  if (!target) return null;
  const proxy = proxies.find((item) => (
    String(item?.name || '').trim().toLowerCase() === target
    || String(item?.proxy_key || item?.proxyKey || '').trim().toLowerCase() === target
  ));
  if (!proxy && target) {
    throw new Error(`SUB2API proxy not found: ${proxyName}`);
  }
  return proxy || null;
}

async function createProxy(origin, token, payload) {
  return requestJson(origin, '/api/v1/admin/proxies', {
    method: 'POST',
    token,
    body: payload,
  });
}

async function updateProxy(origin, token, proxyId, payload) {
  return requestJson(origin, `/api/v1/admin/proxies/${encodeURIComponent(proxyId)}`, {
    method: 'PUT',
    token,
    body: payload,
  });
}

async function getAccount(origin, token, accountId) {
  return requestJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, { token });
}

async function createAccount(origin, token, payload) {
  return requestJson(origin, '/api/v1/admin/accounts', {
    method: 'POST',
    token,
    body: payload,
  });
}

async function updateAccount(origin, token, accountId, payload) {
  return requestJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PUT',
    token,
    body: payload,
  });
}

async function deleteAccount(origin, token, accountId) {
  return requestJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    token,
  });
}

async function generateOpenAiAuthUrl(origin, token, payload = {}) {
  return requestJson(origin, '/api/v1/admin/openai/generate-auth-url', {
    method: 'POST',
    token,
    body: payload,
  });
}

async function exchangeOpenAiCode(origin, token, payload = {}) {
  return requestJson(origin, '/api/v1/admin/openai/exchange-code', {
    method: 'POST',
    token,
    body: payload,
    timeoutMs: 120000,
  });
}

async function importCodexSession(origin, token, payload) {
  return requestJson(origin, '/api/v1/admin/accounts/import/codex-session', {
    method: 'POST',
    token,
    body: payload,
    timeoutMs: 120000,
  });
}

async function listAccountsByName(origin, token, config, name) {
  const params = new URLSearchParams({
    page: '1',
    page_size: '1000',
    platform: config.platform,
    type: config.type,
    search: String(name || ''),
    sort_by: 'name',
    sort_order: 'asc',
  });
  const payload = await requestJson(origin, `/api/v1/admin/accounts?${params}`, { token });
  return extractItems(payload).items.filter((account) => (
    String(account?.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase()
    && accountMatchesGroups(account, config.groupNames)
  ));
}

async function deleteSub2apiAccountsByEmail(email, options = {}) {
  const config = options.config || await loadConfig();
  const { origin, token } = await login(config);
  const accounts = await listAccountsByName(origin, token, config, email);
  const deleted = [];
  for (const account of accounts) {
    if (options.onlyError && String(account.status || '').toLowerCase() !== 'error') continue;
    await deleteAccount(origin, token, account.id);
    deleted.push(normalizeAccount(account));
  }
  return { deleted, count: deleted.length };
}

async function cleanupDuplicateFailedAccounts(options = {}) {
  const config = options.config || await loadConfig();
  const { origin, token } = await login(config);
  const { accounts } = await listFailedAccounts(origin, token, config);
  const groups = new Map();
  for (const account of accounts) {
    const email = String(account.name || '').trim().toLowerCase();
    if (!email) continue;
    if (!groups.has(email)) groups.set(email, []);
    groups.get(email).push(account);
  }

  const deleted = [];
  const kept = [];
  for (const [email, list] of groups.entries()) {
    const sorted = list.slice().sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.updatedAt || '') || Number(left.id || 0);
      const rightTime = Date.parse(right.updated_at || right.updatedAt || '') || Number(right.id || 0);
      return rightTime - leftTime;
    });
    kept.push(normalizeAccount(sorted[0]));
    for (const duplicate of sorted.slice(1)) {
      await deleteAccount(origin, token, duplicate.id);
      deleted.push(normalizeAccount(duplicate));
    }
  }

  return {
    deleted,
    kept,
    deletedCount: deleted.length,
    keptCount: kept.length,
  };
}

async function importAccountData(origin, token, document, options = {}) {
  return requestJson(origin, '/api/v1/admin/accounts/data', {
    method: 'POST',
    token,
    body: {
      data: document,
      skip_default_group_bind: options.skipDefaultGroupBind !== false,
    },
    timeoutMs: 120000,
  });
}

function accountMatchesGroups(account, groupNames = []) {
  const targetNames = new Set(normalizeCsvList(groupNames).map((item) => item.toLowerCase()));
  if (!targetNames.size) return true;

  const groups = Array.isArray(account?.groups) ? account.groups : [];
  if (groups.some((group) => targetNames.has(String(group?.name || '').trim().toLowerCase()))) {
    return true;
  }

  const directNames = [
    account?.group_name,
    account?.groupName,
    account?.group?.name,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  return directNames.some((name) => targetNames.has(name));
}

function normalizeAccount(account) {
  return {
    id: String(account.id || ''),
    name: String(account.name || ''),
    platform: String(account.platform || ''),
    type: String(account.type || ''),
    status: String(account.status || ''),
    errorMessage: String(account.error_message || account.errorMessage || '').trim(),
    schedulable: account.schedulable !== false,
    updatedAt: account.updated_at || account.updatedAt || '',
    groupNames: extractAccountGroupNames(account),
  };
}

function extractAccountGroupNames(account) {
  const names = [];
  if (Array.isArray(account?.groups)) {
    for (const group of account.groups) {
      const name = String(group?.name || '').trim();
      if (name) names.push(name);
    }
  }
  for (const value of [account?.group_name, account?.groupName, account?.group?.name]) {
    const name = String(value || '').trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { failAccounts: {} };
    throw error;
  }
}

async function writeState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function normalizeControl(control = {}) {
  return {
    autoCheckEnabled: control.autoCheckEnabled !== false,
    updatedAt: String(control.updatedAt || ''),
    updatedBy: String(control.updatedBy || ''),
  };
}

async function readControl() {
  try {
    return normalizeControl(JSON.parse(await fs.readFile(CONTROL_PATH, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeControl();
    throw error;
  }
}

async function writeControl(control) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const normalized = normalizeControl(control);
  await fs.writeFile(CONTROL_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

async function setAutoCheckEnabled(enabled, options = {}) {
  const next = await writeControl({
    autoCheckEnabled: Boolean(enabled),
    updatedAt: nowBeijingIso(),
    updatedBy: options.updatedBy || options.by || 'api',
  });
  await appendEventLog(`AUTO-CHECK ${next.autoCheckEnabled ? 'resumed' : 'paused'} by ${next.updatedBy}`);
  return next;
}

async function appendLog(line) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(LOG_PATH, `${line}\n`, 'utf8');
}

async function appendEventLog(message) {
  return appendLog(`[${nowBeijingIso()}] ${message}`);
}

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath = LOCK_PATH) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: nowBeijingIso() }, null, 2)}\n`;

  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.close();
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch {
    existing = {};
  }
  if (isPidAlive(Number(existing.pid))) {
    throw new Error(`Program is already running with PID ${existing.pid}.`);
  }

  await fs.unlink(lockPath).catch(() => {});
  const handle = await fs.open(lockPath, 'wx');
  await handle.writeFile(payload, 'utf8');
  await handle.close();
}

function releaseLockSync(lockPath = LOCK_PATH) {
  try {
    const existing = JSON.parse(fsSync.readFileSync(lockPath, 'utf8'));
    if (Number(existing.pid) === process.pid) fsSync.unlinkSync(lockPath);
  } catch {
    // Best effort cleanup.
  }
}

async function stopLockedProcess(lockPath = LOCK_PATH) {
  if (!fsSync.existsSync(lockPath)) {
    return { stopped: false, message: `No lock file found: ${lockPath}` };
  }
  let lock = {};
  try {
    lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch {
    await fs.unlink(lockPath).catch(() => {});
    return { stopped: false, message: 'Removed invalid lock file.' };
  }
  const pid = Number(lock.pid);
  if (!isPidAlive(pid)) {
    await fs.unlink(lockPath).catch(() => {});
    return { stopped: false, message: 'Process was not running; removed stale lock.', pid };
  }
  process.kill(pid, 'SIGTERM');
  return { stopped: true, pid, message: `Stopped process ${pid}.` };
}

async function checkOnce(config = null) {
  const resolvedConfig = config || await loadConfig();
  const checkedAt = nowBeijingIso();
  const { origin, token } = await login(resolvedConfig);
  const { accounts } = await listFailedAccounts(origin, token, resolvedConfig);
  const current = Object.fromEntries(accounts.map((account) => {
    const normalized = normalizeAccount(account);
    return [normalized.id, normalized];
  }));

  const previousState = await readState();
  const previous = previousState.failAccounts || {};
  const newFailures = [];
  const changedFailures = [];
  const recovered = [];
  const nextFailAccounts = {};

  for (const [id, account] of Object.entries(current)) {
    const old = previous[id];
    const next = {
      ...account,
      firstSeenAt: old?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt,
      lastChangedAt: old?.lastChangedAt || checkedAt,
    };

    if (!old) {
      newFailures.push(next);
      next.lastChangedAt = checkedAt;
    } else if ((old.errorMessage || '') !== account.errorMessage || old.name !== account.name) {
      changedFailures.push(next);
      next.lastChangedAt = checkedAt;
    }
    nextFailAccounts[id] = next;
  }

  for (const [id, account] of Object.entries(previous)) {
    if (!current[id]) recovered.push({ ...account, recoveredAt: checkedAt });
  }

  const nextState = {
    lastCheckedAt: checkedAt,
    latestFailCount: Object.keys(current).length,
    latestNewFailCount: newFailures.length,
    latestChangedFailCount: changedFailures.length,
    latestRecoveredCount: recovered.length,
    failAccounts: nextFailAccounts,
    lastRecovered: recovered,
  };
  await writeState(nextState);

  const summary = {
    checkedAt,
    failCount: Object.keys(current).length,
    currentFailures: Object.values(nextFailAccounts),
    newFailures,
    changedFailures,
    recovered,
  };

  await appendLog(`[${checkedAt}] fail=${summary.failCount} new=${newFailures.length} changed=${changedFailures.length} recovered=${recovered.length}`);
  for (const account of [...newFailures, ...changedFailures]) {
    await appendLog(`  #${account.id} ${account.name || '(unnamed)'}: ${account.errorMessage || '(no error message)'}`);
  }

  return summary;
}

function formatSummary(summary) {
  const lines = [
    `[${summary.checkedAt}] fail accounts: ${summary.failCount}, new: ${summary.newFailures.length}, changed: ${summary.changedFailures.length}, recovered: ${summary.recovered.length}`,
  ];
  for (const prefix of ['newFailures', 'changedFailures', 'recovered']) {
    const label = prefix === 'newFailures' ? 'NEW' : prefix === 'changedFailures' ? 'CHANGED' : 'RECOVERED';
    for (const account of summary[prefix] || []) {
      const detail = account.errorMessage ? ` - ${account.errorMessage}` : '';
      lines.push(`${label} #${account.id} ${account.name || '(unnamed)'}${detail}`);
    }
  }
  return lines.join('\n');
}

async function readLock(lockPath = LOCK_PATH) {
  try {
    return JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  CONTROL_PATH,
  DATA_DIR,
  ENV_PATH,
  LEGACY_LOCK_PATH,
  LOCK_PATH,
  LOG_PATH,
  STATE_PATH,
  acquireLock,
  appendEventLog,
  appendLog,
  checkOnce,
  cleanupDuplicateFailedAccounts,
  createAccount,
  createProxy,
  deleteAccount,
  deleteSub2apiAccountsByEmail,
  exchangeOpenAiCode,
  formatSummary,
  generateOpenAiAuthUrl,
  getAccount,
  getOrigin,
  importAccountData,
  importCodexSession,
  isPidAlive,
  listAllProxies,
  listFailedAccounts,
  listAccountsByName,
  listGroups,
  listProxies,
  loadConfig,
  login,
  formatBeijingIso,
  nowBeijingIso,
  readControl,
  readLock,
  readState,
  releaseLockSync,
  requestJson,
  resolveGroupIds,
  resolveProxy,
  setAutoCheckEnabled,
  stopLockedProcess,
  updateAccount,
  updateProxy,
  writeControl,
  accountMatchesGroups,
  extractAccountGroupNames,
};
