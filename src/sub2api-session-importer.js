const fs = require('fs/promises');
const path = require('path');
const converter = require('./chatgpt-session-converter');
const monitor = require('./sub2api-monitor');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const CONVERTED_DIR = path.join(DATA_DIR, 'converted-sub2api');

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function timestampToken(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function sanitizeFileToken(value, fallback = 'chatgpt-session') {
  return String(value || fallback)
    .replace(/\.[^.]+$/u, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || fallback;
}

function ensureSessionShape(session, overrides = {}) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('ChatGPT session file must contain a JSON object.');
  }
  return {
    ...session,
    ...(overrides.email ? { email: overrides.email } : {}),
  };
}

function extractCodexSessionContent(session) {
  const candidates = [
    session,
    session?.session,
    session?.data,
    session?.value,
  ];
  for (const candidate of candidates) {
    const accessToken = converter.firstNonEmpty(
      candidate?.accessToken,
      candidate?.access_token,
      candidate?.token?.accessToken,
      candidate?.token?.access_token,
      candidate?.credentials?.accessToken,
      candidate?.credentials?.access_token,
    );
    if (accessToken) return JSON.stringify(candidate);
  }
  throw new Error('ChatGPT session JSON does not contain accessToken.');
}

function proxyForExport(proxy) {
  if (!proxy) return null;
  return converter.normalizeProxy({
    proxy_key: proxy.proxy_key || proxy.proxyKey,
    name: proxy.name,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    status: proxy.status || 'active',
  });
}

async function resolveSub2apiTargets(config, options = {}) {
  const proxyName = options.proxyName !== undefined ? options.proxyName : config.proxyName;
  const { origin, token } = await monitor.login(config);
  const [groupIds, proxy] = await Promise.all([
    monitor.resolveGroupIds(origin, token, config.groupNames, config.platform),
    monitor.resolveProxy(origin, token, proxyName),
  ]);
  return {
    origin,
    token,
    groupIds,
    proxy,
    proxyName,
    exportProxy: proxyForExport(proxy),
  };
}

async function convertSessionFile(inputPath, options = {}) {
  const config = await monitor.loadConfig();
  const session = ensureSessionShape(await readJson(inputPath), {
    email: options.email,
  });
  const targets = await resolveSub2apiTargets(config, {
    proxyName: options.sub2apiProxyName,
  });
  const result = converter.convertSessionsToSub2api([session], {
    groupName: config.groupNames[0],
    proxy: targets.exportProxy,
    concurrency: config.concurrency,
    priority: config.priority,
    rateMultiplier: config.rateMultiplier,
    sourceName: path.basename(inputPath),
  });

  const base = sanitizeFileToken(
    result.converted[0]?.email || result.converted[0]?.name || path.basename(inputPath),
    'chatgpt-session',
  );
  const outputPath = options.outputPath || path.join(CONVERTED_DIR, `${base}.sub2api.${timestampToken()}.json`);
  await writeJson(outputPath, result.document);

  return {
    ok: result.converted.length > 0 && result.skipped.length === 0,
    outputPath,
    skipped: result.skipped,
    summary: converter.summarizeSub2apiDocument(result.document),
  };
}

async function saveCapturedSession(email, session, options = {}) {
  const safeEmail = sanitizeFileToken(email || session?.user?.email || session?.email, 'chatgpt-session');
  const outputPath = options.outputPath || path.join(SESSION_DIR, `${safeEmail}.session.${timestampToken()}.local.json`);
  await writeJson(outputPath, session);
  return outputPath;
}

async function importSessionFile(inputPath, options = {}) {
  const config = await monitor.loadConfig();
  const session = ensureSessionShape(await readJson(inputPath), {
    email: options.email,
  });
  const targets = await resolveSub2apiTargets(config, {
    proxyName: options.sub2apiProxyName,
  });
  if (!targets.groupIds.length) {
    throw new Error(`No SUB2API group ids resolved for ${config.groupNames.join(', ')}`);
  }

  const content = extractCodexSessionContent(session);
  const extra = {
    import_source: 'codex_auto_relogin',
    imported_at: new Date().toISOString(),
  };
  const payload = {
    content,
    name: options.name || session.user?.email || session.email || '',
    notes: options.notes || null,
    concurrency: config.concurrency,
    priority: config.priority,
    rate_multiplier: config.rateMultiplier,
    group_ids: targets.groupIds,
    auto_pause_on_expired: true,
    extra,
    update_existing: true,
  };
  if (targets.proxy?.id) {
    payload.proxy_id = Number(targets.proxy.id);
  }
  const response = await monitor.importCodexSession(targets.origin, targets.token, payload);
  const accountName = options.name || session.user?.email || session.email || '';
  const postImport = await recoverImportedAccounts(targets.origin, targets.token, response, {
    accountName,
    config,
  });

  return {
    ok: Number(response?.failed || 0) === 0 && postImport.every((item) => item.ok),
    response,
    postImport,
    target: {
      groupIds: targets.groupIds,
      groupNames: config.groupNames,
      proxyId: targets.proxy?.id ? Number(targets.proxy.id) : null,
      proxyName: targets.proxy?.name || targets.proxyName || '',
      concurrency: config.concurrency,
    },
  };
}

async function recoverImportedAccounts(origin, token, response, options = {}) {
  let accountIds = extractImportedAccountIds(response);
  if (!accountIds.length && options.accountName) {
    const accounts = await monitor.listAccountsByName(origin, token, options.config, options.accountName).catch(() => []);
    accountIds = accounts
      .map((account) => Number(account.id))
      .filter((id) => Number.isFinite(id) && id > 0);
  }
  const results = [];
  for (const accountId of accountIds) {
    const steps = [];
    for (const requestPath of [
      `/api/v1/admin/accounts/${accountId}/clear-error`,
      `/api/v1/admin/accounts/${accountId}/recover-state`,
      `/api/v1/admin/accounts/${accountId}/test`,
    ]) {
      try {
        await monitor.requestJson(origin, requestPath, {
          method: 'POST',
          token,
          timeoutMs: 120000,
        });
        steps.push({ path: requestPath, ok: true });
      } catch (error) {
        steps.push({ path: requestPath, ok: false, error: error.message });
      }
    }
    results.push({
      accountId,
      ok: steps.every((step) => step.ok),
      steps,
    });
  }
  return results;
}

function extractImportedAccountIds(response) {
  const ids = new Set();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const id = Number(value.id || value.account_id || value.accountId);
    if (Number.isFinite(id) && id > 0) ids.add(id);
    for (const item of Object.values(value)) visit(item);
  };
  visit(response?.accounts);
  visit(response?.created_accounts);
  visit(response?.updated_accounts);
  visit(response?.created);
  visit(response?.updated);
  visit(response?.results);
  return [...ids];
}

async function importConvertedDocument(inputPath, options = {}) {
  const config = await monitor.loadConfig();
  const document = await readJson(inputPath);
  const targets = await resolveSub2apiTargets(config, {
    proxyName: options.sub2apiProxyName,
  });
  const patched = converter.applySub2apiDefaults(document, {
    groupName: config.groupNames[0],
    proxy: targets.exportProxy,
    concurrency: config.concurrency,
    priority: config.priority,
    rateMultiplier: config.rateMultiplier,
  });
  const response = await monitor.importAccountData(targets.origin, targets.token, patched, {
    skipDefaultGroupBind: options.skipDefaultGroupBind !== false,
  });
  return {
    ok: Number(response?.account_failed || 0) === 0 && Number(response?.proxy_failed || 0) === 0,
    response,
    summary: converter.summarizeSub2apiDocument(patched),
  };
}

function summarizeImportResult(result) {
  const response = result.response || {};
  return {
    ok: Boolean(result.ok),
    created: Number(response.created || response.account_created || 0),
    updated: Number(response.updated || 0),
    skipped: Number(response.skipped || 0),
    failed: Number(response.failed || response.account_failed || 0),
    proxyCreated: Number(response.proxy_created || 0),
    proxyReused: Number(response.proxy_reused || 0),
    proxyFailed: Number(response.proxy_failed || 0),
    target: result.target,
    postImport: result.postImport || [],
    errors: response.errors || [],
    warnings: response.warnings || [],
  };
}

module.exports = {
  CONVERTED_DIR,
  SESSION_DIR,
  convertSessionFile,
  importConvertedDocument,
  importSessionFile,
  saveCapturedSession,
  summarizeImportResult,
};
