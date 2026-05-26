const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const accountStore = require('./account-store');
const { checkAccount, getLatestVerificationCode } = require('./mail-client');
const monitor = require('./sub2api-monitor');
const browserRelogin = require('./chatgpt-browser-relogin');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public', 'web');
const DEFAULT_WEB_PORT = 8083;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function webAccount(account) {
  return {
    id: account.id,
    email: account.email,
    status: account.status,
    used: Boolean(account.used),
    hasPassword: Boolean(account.password),
    hasClientId: Boolean(account.clientId),
    hasRefreshToken: Boolean(account.refreshToken),
    lastAuthAt: Number(account.lastAuthAt || 0) || 0,
    lastUsedAt: Number(account.lastUsedAt || 0) || 0,
    lastError: account.lastError ? String(account.lastError).slice(0, 300) : '',
    source: account.source,
  };
}

function webCheckResult(result) {
  return {
    ok: Boolean(result.ok),
    account: result.account ? webAccount(result.account) : null,
    messageCount: Number(result.messageCount || 0) || 0,
    latestCode: result.latestCode || '',
    latestMessage: result.latestMessage ? {
      mailbox: result.latestMessage.mailbox || '',
      subject: result.latestMessage.subject || '',
      from: result.latestMessage.from?.emailAddress?.address || '',
      receivedDateTime: result.latestMessage.receivedDateTime || '',
    } : null,
    mailboxResults: result.mailboxResults || [],
    tokenMeta: result.tokenMeta || null,
    error: result.error || '',
  };
}

function parseJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, error, statusCode = 500) {
  sendJson(res, statusCode, {
    ok: false,
    error: error.message || String(error),
  });
}

async function tailFile(filePath, maxLines = 200) {
  if (!fsSync.existsSync(filePath)) return [];
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines
    .slice(-Math.max(1, Math.min(Number(maxLines) || 200, 1000)))
    .map((line) => line.replace(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+Z)\]/, (match, value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return match;
      return `[${monitor.formatBeijingIso(date)}]`;
    }));
}

async function getStatusPayload() {
  const config = await monitor.loadConfig().catch((error) => ({ error: error.message }));
  const state = await monitor.readState().catch(() => ({ failAccounts: {} }));
  const control = await monitor.readControl().catch(() => ({ autoCheckEnabled: true }));
  const lock = await monitor.readLock(monitor.LOCK_PATH);
  const accounts = accountStore.loadAccounts().map(webAccount);
  return {
    ok: true,
    checkedAt: monitor.nowBeijingIso(),
    web: {
      port: Number(process.env.WEB_PORT || DEFAULT_WEB_PORT),
    },
    sub2api: {
      groupNames: config.groupNames || [],
      intervalMinutes: config.intervalMinutes || 0,
      autoCheckEnabled: control.autoCheckEnabled !== false,
      controlUpdatedAt: control.updatedAt || '',
      controlUpdatedBy: control.updatedBy || '',
      latestFailCount: state.latestFailCount || 0,
      lastCheckedAt: state.lastCheckedAt || '',
      currentFailures: Object.values(state.failAccounts || {}),
      lock: lock ? {
        pid: Number(lock.pid || 0),
        startedAt: lock.startedAt || '',
        alive: monitor.isPidAlive(Number(lock.pid || 0)),
      } : null,
      configError: config.error || '',
    },
    mail: {
      count: accounts.length,
      authorized: accounts.filter((account) => account.status === 'authorized').length,
      error: accounts.filter((account) => account.status === 'error').length,
      pending: accounts.filter((account) => account.status === 'pending').length,
      accounts,
    },
  };
}

async function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(target).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    sendError(res, new Error('Forbidden.'), 403);
    return;
  }
  try {
    const content = await fs.readFile(resolved);
    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendError(res, new Error('Not found.'), 404);
      return;
    }
    throw error;
  }
}

function resolveRequestedEmails(body, options = {}) {
  const requested = Array.isArray(body.emails) ? body.emails : [];
  const normalized = requested.map((email) => String(email || '').trim()).filter(Boolean);
  if (normalized.length) return normalized;
  if (options.allowAll === false) return [];
  return accountStore.loadAccounts().map((account) => account.email).filter(Boolean);
}

function resolveReloginOptions(body = {}) {
  const mode = String(body.proxyMode || 'none').trim();
  const options = {
    headless: true,
  };

  if (mode === 'none') {
    options.proxy = false;
    return { options, proxyMode: mode, proxyLabel: 'direct' };
  }

  if (mode === 'sub2api') {
    options.useSub2apiProxy = true;
    return { options, proxyMode: mode, proxyLabel: 'sub2api-config' };
  }

  if (mode === 'custom') {
    const server = String(body.proxyServer || '').trim();
    if (!server) throw new Error('Missing custom proxy server.');
    options.proxyServer = server;
    options.proxyUsername = String(body.proxyUsername || '').trim();
    options.proxyPassword = String(body.proxyPassword || '');
    return { options, proxyMode: mode, proxyLabel: server.replace(/\/\/([^:@/]+):([^@/]+)@/u, '//***:***@') };
  }

  throw new Error('Invalid proxy mode.');
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, await getStatusPayload());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const lines = await tailFile(monitor.LOG_PATH, Number(url.searchParams.get('lines') || 240));
    sendJson(res, 200, { ok: true, lines });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mail/import-lines') {
    const body = await parseJsonBody(req);
    const result = accountStore.importFromHotmailAccountLines(String(body.text || ''), {
      source: 'web-lines',
    });
    await monitor.appendEventLog(`WEB import mail lines imported=${result.imported} added=${result.added} updated=${result.updated} errors=${result.errors.length}`);
    sendJson(res, 200, {
      ok: result.errors.length === 0,
      importedAccounts: result.imported,
      added: result.added,
      updated: result.updated,
      errors: result.errors,
      accounts: result.accounts.map(webAccount),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mail/check') {
    const body = await parseJsonBody(req);
    const emails = resolveRequestedEmails(body);
    const results = [];
    for (const email of emails) {
      const result = await checkAccount(email, {
        top: Number(body.top || 5) || 5,
      });
      results.push(webCheckResult(result));
      await monitor.appendEventLog(`WEB mail check ${result.ok ? 'OK' : 'FAIL'} ${email}: ${result.error || `messages=${result.messageCount || 0}`}`);
    }
    sendJson(res, 200, {
      ok: results.every((result) => result.ok),
      checked: results.length,
      results,
      accounts: accountStore.loadAccounts().map(webAccount),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mail/latest-code') {
    const body = await parseJsonBody(req);
    const email = String(body.email || '').trim();
    if (!email) throw new Error('Missing email.');
    const result = await getLatestVerificationCode(email, {
      kind: body.kind || 'login',
      top: Number(body.top || 10) || 10,
    });
    await monitor.appendEventLog(`WEB latest code ${result.ok ? 'OK' : 'FAIL'} ${email}: ${result.error || result.message?.receivedDateTime || ''}`);
    sendJson(res, 200, {
      ok: Boolean(result.ok),
      account: result.account ? webAccount(result.account) : null,
      code: result.code || '',
      mailbox: result.message?.mailbox || '',
      subject: result.message?.subject || '',
      receivedDateTime: result.message?.receivedDateTime || '',
      error: result.error || '',
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mail/delete') {
    const body = await parseJsonBody(req);
    const emails = resolveRequestedEmails(body, { allowAll: false });
    if (!emails.length) throw new Error('No mailboxes selected for deletion.');
    const deleteSub2api = Boolean(body.deleteSub2api);
    const results = [];
    for (const email of emails) {
      if (deleteSub2api) {
        const result = await browserRelogin.cleanupDeadMailbox(email, 'web_manual_delete');
        results.push(result);
        await monitor.appendEventLog(`WEB delete ${email}: mail=${result.mailDeleted} sub2api=${result.sub2apiDeleted}${result.sub2apiError ? ` sub2apiError=${result.sub2apiError}` : ''}`);
      } else {
        const result = accountStore.deleteAccount(email);
        results.push({ email, mailDeleted: result.deleted, sub2apiDeleted: 0 });
        await monitor.appendEventLog(`WEB delete ${email}: mail=${result.deleted} sub2api=skipped`);
      }
    }
    sendJson(res, 200, {
      ok: true,
      deleted: results,
      accounts: accountStore.loadAccounts().map(webAccount),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/relogin/import') {
    const body = await parseJsonBody(req);
    const emails = resolveRequestedEmails(body, { allowAll: false });
    if (!emails.length) throw new Error('No mailboxes selected for relogin.');
    const { options, proxyMode, proxyLabel } = resolveReloginOptions(body);
    const results = [];

    for (const email of emails) {
      await monitor.appendEventLog(`WEB relogin START ${email}: proxy=${proxyLabel}`);
      try {
        const result = await browserRelogin.reloginImport(email, options);
        results.push({
          ok: Boolean(result.ok),
          email,
          proxyMode,
          proxyServer: result.capture?.proxyServer || '',
          loginAttempts: result.capture?.loginAttempts || 0,
          sessionPath: result.capture?.sessionPath || '',
          codeReceivedAt: result.capture?.codeReceivedAt || '',
          deletedBeforeImport: result.preImportCleanup?.count || 0,
          import: result.import,
        });
        await monitor.appendEventLog(`WEB relogin OK ${email}: proxy=${result.capture?.proxyServer || 'direct'} created=${result.import?.created || 0} updated=${result.import?.updated || 0}`);
      } catch (error) {
        results.push({
          ok: false,
          email,
          proxyMode,
          error: error.message || String(error),
          cleanup: error.cleanup || null,
        });
        await monitor.appendEventLog(`WEB relogin FAIL ${email}: ${error.message || error}`);
      }
    }

    sendJson(res, 200, {
      ok: results.every((result) => result.ok),
      reloginCount: results.length,
      successCount: results.filter((result) => result.ok).length,
      results,
      accounts: accountStore.loadAccounts().map(webAccount),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sub2api/check') {
    const summary = await monitor.checkOnce();
    sendJson(res, 200, { ok: true, summary });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sub2api/auto-check') {
    const body = await parseJsonBody(req);
    if (typeof body.enabled !== 'boolean') throw new Error('Missing boolean enabled.');
    const control = await monitor.setAutoCheckEnabled(body.enabled, { updatedBy: 'web' });
    sendJson(res, 200, {
      ok: true,
      autoCheckEnabled: control.autoCheckEnabled,
      updatedAt: control.updatedAt,
      updatedBy: control.updatedBy,
    });
    return;
  }

  sendError(res, new Error('Not found.'), 404);
}

function startWebServer(options = {}) {
  const port = Number(options.port || process.env.WEB_PORT || DEFAULT_WEB_PORT);
  const host = options.host || process.env.WEB_HOST || '0.0.0.0';
  const server = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, new Error('Method not allowed.'), 405);
        return;
      }
      await serveStatic(req, res, url.pathname);
    })().catch((error) => sendError(res, error));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        server,
        port,
        host,
        url: `http://localhost:${port}`,
      });
    });
  });
}

module.exports = {
  DEFAULT_WEB_PORT,
  startWebServer,
};
