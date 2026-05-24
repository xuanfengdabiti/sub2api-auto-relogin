import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const envPath = path.join(rootDir, '.env.local');
const dataDir = path.join(rootDir, 'data');
const statePath = path.join(dataDir, 'sub2api-fail-monitor-state.json');
const logPath = path.join(dataDir, 'sub2api-fail-monitor.log');
const lockPath = path.join(dataDir, 'sub2api-fail-monitor.lock');

const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const jsonOutput = args.has('--json');
const noLock = args.has('--no-lock');

function parseEnv(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
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
    fileEnv = parseEnv(await fs.readFile(envPath, 'utf8'));
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
  };

  const missing = [];
  if (!config.url) missing.push('SUB2API_URL');
  if (!config.email) missing.push('SUB2API_EMAIL');
  if (!config.password) missing.push('SUB2API_PASSWORD');
  if (missing.length) {
    throw new Error(`Missing config: ${missing.join(', ')}. Fill ${envPath}.`);
  }
  if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes <= 0) {
    config.intervalMinutes = 30;
  }
  return config;
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

  return { accounts: all.filter((account) => String(account?.status || '').toLowerCase() === 'error'), total };
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
  };
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { failAccounts: {} };
    throw error;
  }
}

async function writeState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function appendLog(line) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(logPath, `${line}\n`, 'utf8');
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

async function acquireLock() {
  await fs.mkdir(dataDir, { recursive: true });
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`;

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
    throw new Error(`Monitor is already running with PID ${existing.pid}.`);
  }

  await fs.unlink(lockPath).catch(() => {});
  const handle = await fs.open(lockPath, 'wx');
  await handle.writeFile(payload, 'utf8');
  await handle.close();
}

function releaseLockSync() {
  try {
    const existing = JSON.parse(fsSync.readFileSync(lockPath, 'utf8'));
    if (Number(existing.pid) === process.pid) fsSync.unlinkSync(lockPath);
  } catch {
    // Best effort cleanup.
  }
}

async function checkOnce(config) {
  const checkedAt = new Date().toISOString();
  const { origin, token } = await login(config);
  const { accounts } = await listFailedAccounts(origin, token, config);
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

function formatAccount(account) {
  const detail = account.errorMessage ? ` - ${account.errorMessage}` : '';
  return `#${account.id} ${account.name || '(unnamed)'}${detail}`;
}

function printSummary(summary) {
  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`[${summary.checkedAt}] fail accounts: ${summary.failCount}, new: ${summary.newFailures.length}, changed: ${summary.changedFailures.length}, recovered: ${summary.recovered.length}`);
  for (const account of summary.newFailures) console.log(`NEW ${formatAccount(account)}`);
  for (const account of summary.changedFailures) console.log(`CHANGED ${formatAccount(account)}`);
  for (const account of summary.recovered) console.log(`RECOVERED ${formatAccount(account)}`);
}

async function run() {
  const config = await loadConfig();
  if (!once && !noLock) await acquireLock();

  const intervalMs = Math.max(1, Math.floor(config.intervalMinutes)) * 60 * 1000;
  const runAndReport = async () => {
    try {
      const summary = await checkOnce(config);
      printSummary(summary);
    } catch (error) {
      const checkedAt = new Date().toISOString();
      await appendLog(`[${checkedAt}] ERROR ${error.stack || error.message || error}`);
      throw error;
    }
  };

  await runAndReport();
  if (once) return;

  console.log(`Next checks every ${Math.round(intervalMs / 60000)} minute(s).`);
  setInterval(() => {
    runAndReport().catch((error) => {
      console.error(error.stack || error.message || error);
    });
  }, intervalMs);
}

process.on('exit', releaseLockSync);
process.on('SIGINT', () => {
  releaseLockSync();
  process.exit(130);
});
process.on('SIGTERM', () => {
  releaseLockSync();
  process.exit(143);
});

run().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

