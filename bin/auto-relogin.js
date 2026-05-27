#!/usr/bin/env node
const {
  ACCOUNT_STORE_PATH,
  DEFAULT_RAW_STORAGE_PATH,
  deleteAccount,
  importFromGuJumpgateStorage,
  importFromGuJumpgateStorageMerge,
  importFromHotmailAccountLineFile,
  findAccount,
  loadAccounts,
  parseHotmailAccountLine,
  summarizeAccount,
  upsertAccount,
} = require('../src/account-store');
const {
  checkAccount,
  getLatestVerificationCode,
} = require('../src/mail-client');
const monitor = require('../src/sub2api-monitor');
const sessionImporter = require('../src/sub2api-session-importer');
const browserRelogin = require('../src/chatgpt-browser-relogin');
const { startWebServer } = require('../src/web-server');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return [
    'Usage:',
    '  node bin/auto-relogin.js status',
    '  node bin/auto-relogin.js run [--once] [--json] [--no-lock]',
    '  node bin/auto-relogin.js web [--port 8083]',
    '  node bin/auto-relogin.js start',
    '  node bin/auto-relogin.js stop',
    '  node bin/auto-relogin.js sub2api:check [--json]',
    '  node bin/auto-relogin.js sub2api:auto-check enable|disable|status',
    '  node bin/auto-relogin.js sub2api:cleanup-duplicates --apply [--json]',
    '  node bin/auto-relogin.js cleanup:dead-mailbox --account email --apply [--json]',
    '  node bin/auto-relogin.js session:convert --from path [--out path] [--json]',
    '  node bin/auto-relogin.js session:import --from path [--json]',
    '  node bin/auto-relogin.js sub2api:import-json --from path [--json]',
    '  node bin/auto-relogin.js relogin:capture --account email [--json] [--headless]',
    '  node bin/auto-relogin.js relogin:import --account email [--json] [--headless]',
    '  node bin/auto-relogin.js mail:import [--from path]',
    '  node bin/auto-relogin.js mail:list',
    '  node bin/auto-relogin.js mail:delete --account email-or-id --apply',
    '  node bin/auto-relogin.js mail:add --email user@example.com --client-id id --refresh-token token [--password pwd]',
    '  node bin/auto-relogin.js mail:add --line "email----password----clientId----refreshToken"',
    '  node bin/auto-relogin.js mail:import-lines --from accounts.txt',
    '  node bin/auto-relogin.js mail:check [--account email-or-id] [--top 5]',
    '  node bin/auto-relogin.js mail:check-all [--top 3]',
    '  node bin/auto-relogin.js mail:latest-code [--account email-or-id] [--kind login|signup] [--top 10]',
  ].join('\n');
}

function requirePathArg(args, name = 'from') {
  const value = args[name] || args._[1];
  if (!value || value === true) {
    throw new Error(`Missing --${name} path.`);
  }
  return value;
}

function printSessionConvertResult(result, json = false) {
  if (json) {
    printJson(result);
    return;
  }
  const lines = [
    `Converted sessions: ${result.summary.accountCount}`,
    `Output: ${result.outputPath}`,
    `Proxies: ${result.summary.proxyCount}`,
    `Skipped: ${result.skipped.length}`,
  ];
  for (const account of result.summary.accounts) {
    lines.push(`- ${account.email || account.name || '(unknown)'} group=${account.groupNames.join(',') || '-'} proxy=${account.proxyName || '-'} concurrency=${account.concurrency}`);
  }
  if (result.skipped.length) {
    for (const item of result.skipped) {
      lines.push(`SKIPPED ${item.sourceName || 'input'} ${item.path || '$'}: ${item.reason}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printImportResult(result, json = false) {
  const summary = sessionImporter.summarizeImportResult(result);
  if (json) {
    printJson(summary);
    return;
  }
  const lines = [
    `Import ok: ${summary.ok}`,
    `Created: ${summary.created}, updated: ${summary.updated}, skipped: ${summary.skipped}, failed: ${summary.failed}`,
  ];
  if (summary.target) {
    lines.push(`Target: group=${(summary.target.groupNames || []).join(',') || summary.target.groupIds?.join(',') || '-'} proxy=${summary.target.proxyName || summary.target.proxyId || '-'} concurrency=${summary.target.concurrency || '-'}`);
  }
  if (summary.proxyCreated || summary.proxyReused || summary.proxyFailed) {
    lines.push(`Proxy: created=${summary.proxyCreated}, reused=${summary.proxyReused}, failed=${summary.proxyFailed}`);
  }
  for (const warning of summary.warnings || []) {
    lines.push(`WARNING ${warning.message || JSON.stringify(warning)}`);
  }
  for (const error of summary.errors || []) {
    lines.push(`ERROR ${error.message || JSON.stringify(error)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printCaptureResult(result, json = false) {
  if (json) {
    printJson({
      ok: result.ok,
      email: result.email,
      sessionPath: result.sessionPath,
      codeMailbox: result.codeMailbox,
      codeReceivedAt: result.codeReceivedAt,
    });
    return;
  }
  process.stdout.write([
    `Capture ok: ${result.ok}`,
    `Email: ${result.email}`,
    `Session saved: ${result.sessionPath}`,
    `Code mailbox: ${result.codeMailbox || '-'}`,
    `Code received: ${result.codeReceivedAt || '-'}`,
  ].join('\n') + '\n');
}

function printReloginImportResult(result, json = false) {
  if (json) {
    printJson(result);
    return;
  }
  process.stdout.write([
    `Relogin/import ok: ${result.ok}`,
    `Email: ${result.capture.email}`,
    `Session saved: ${result.capture.sessionPath}`,
    `Deleted old failed duplicates before import: ${result.preImportCleanup?.count || 0}`,
    `Created: ${result.import.created}, updated: ${result.import.updated}, skipped: ${result.import.skipped}, failed: ${result.import.failed}`,
    result.import.target ? `Target: group=${(result.import.target.groupNames || []).join(',') || '-'} proxy=${result.import.target.proxyName || '-'} concurrency=${result.import.target.concurrency || '-'}` : '',
  ].filter(Boolean).join('\n') + '\n');
}

function printDuplicateCleanupResult(result, json = false) {
  if (json) {
    printJson(result);
    return;
  }
  const lines = [
    `Duplicate failed cleanup: deleted=${result.deletedCount}, kept=${result.keptCount}`,
  ];
  for (const account of result.deleted || []) {
    lines.push(`DELETED #${account.id} ${account.name}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function redactCheckResult(result) {
  return {
    ok: result.ok,
    account: result.account ? summarizeAccount(result.account) : null,
    messageCount: result.messageCount || 0,
    mailboxResults: result.mailboxResults || [],
    latestCode: result.latestCode || '',
    latestMessage: result.latestMessage ? {
      mailbox: result.latestMessage.mailbox,
      subject: result.latestMessage.subject,
      from: result.latestMessage.from?.emailAddress?.address || '',
      receivedDateTime: result.latestMessage.receivedDateTime,
      bodyPreview: String(result.latestMessage.bodyPreview || '').slice(0, 160),
    } : null,
    tokenMeta: result.tokenMeta || null,
    error: result.error || '',
  };
}

function redactCodeResult(result) {
  return {
    ok: result.ok,
    account: result.account ? summarizeAccount(result.account) : null,
    code: result.code || '',
    mailbox: result.message?.mailbox || '',
    subject: result.message?.subject || '',
    from: result.message?.from?.emailAddress?.address || '',
    receivedDateTime: result.message?.receivedDateTime || '',
    emailTimestamp: result.emailTimestamp || 0,
    usedTimeFallback: Boolean(result.usedTimeFallback),
    usedRelaxedFilters: Boolean(result.usedRelaxedFilters),
    mailboxResults: result.mailboxResults || [],
    error: result.error || '',
  };
}

function printMonitorSummary(summary, json = false) {
  if (json) {
    printJson(summary);
  } else {
    process.stdout.write(`${monitor.formatSummary(summary)}\n`);
  }
}

function envBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

function shouldUseHeadlessBrowser(options = {}) {
  if (options.headless !== undefined) return Boolean(options.headless);
  if (process.env.CHATGPT_RELOGIN_HEADLESS !== undefined) {
    return envBoolean('CHATGPT_RELOGIN_HEADLESS', true);
  }
  if (process.env.PLAYWRIGHT_HEADLESS !== undefined) {
    return envBoolean('PLAYWRIGHT_HEADLESS', true);
  }
  return process.platform !== 'win32' && !process.env.DISPLAY;
}

function summarizeError(error) {
  const message = String(error?.message || error || '').trim();
  const firstLine = message.split(/\r?\n/).find(Boolean) || 'Unknown error';
  if (/browserType\.launchPersistentContext/i.test(firstLine)) {
    return firstLine.replace(/\s+/g, ' ').slice(0, 240);
  }
  return firstLine.slice(0, 500);
}

async function reloginFailedAccounts(accounts, options = {}) {
  const results = [];
  const seen = new Set();
  const headless = shouldUseHeadlessBrowser(options);
  for (const account of accounts || []) {
    const email = String(account.name || '').trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    const localAccount = findAccount(email);
    if (browserRelogin.isDeletedOrDeactivatedAccountText(account.errorMessage || '')) {
      const banned = localAccount
        ? await browserRelogin.markChatGptBanned(email, account.errorMessage || 'sub2api_account_deleted_or_deactivated')
        : null;
      results.push({
        ok: false,
        account,
        email,
        skipped: true,
        error: 'ChatGPT account is banned/deactivated; kept without deletion.',
        cleanup: null,
        banned,
      });
      await monitor.appendEventLog(`AUTO-RELOGIN BANNED ${email}: ${banned?.gptBannedAt || ''} ${account.errorMessage || ''}`);
      continue;
    }
    if (!localAccount) {
      results.push({
        ok: false,
        account,
        email,
        skipped: true,
        error: `Hotmail account not found locally: ${email}`,
        cleanup: null,
      });
      await monitor.appendEventLog(`AUTO-RELOGIN SKIP ${email}: missing local mailbox; no deletion performed`);
      continue;
    }
    try {
      const result = await browserRelogin.reloginImport(email, {
        debug: false,
        headless,
      });
      results.push({
        ok: Boolean(result.ok),
        account,
        email,
        sessionPath: result.capture?.sessionPath || '',
        codeReceivedAt: result.capture?.codeReceivedAt || '',
        deletedBeforeImport: result.preImportCleanup?.count || 0,
        import: result.import,
      });
      await monitor.appendEventLog(`AUTO-RELOGIN OK ${email}: session=${result.capture?.sessionPath || ''} imported created=${result.import?.created || 0} updated=${result.import?.updated || 0}`);
    } catch (error) {
      results.push({
        ok: false,
        account,
        email,
        error: summarizeError(error),
        cleanup: error.cleanup || null,
        banned: error.banned || null,
      });
      if (error.banned) {
        await monitor.appendEventLog(`AUTO-RELOGIN BANNED ${email}: ${error.banned.gptBannedAt || ''} ${summarizeError(error)}`);
      } else if (error.cleanup) {
        await monitor.appendEventLog(`AUTO-RELOGIN CLEANUP ${email}: ${summarizeError(error)} mail=${error.cleanup.mailDeleted || 0} sub2api=${error.cleanup.sub2apiDeleted || 0}`);
      } else {
        await monitor.appendEventLog(`AUTO-RELOGIN FAIL ${email}: ${summarizeError(error)}`);
      }
    }
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSub2apiReady(config, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || process.env.SUB2API_STARTUP_WAIT_ATTEMPTS || 24));
  const delayMs = Math.max(1000, Number(options.delayMs || process.env.SUB2API_STARTUP_WAIT_SECONDS || 5) * 1000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await monitor.login(config);
      if (attempt > 1) {
        await monitor.appendEventLog(`SUB2API ready after ${attempt} startup check(s).`);
      }
      return true;
    } catch (error) {
      lastError = error;
      await monitor.appendEventLog(`SUB2API not ready (${attempt}/${attempts}): ${error.message}`);
      if (attempt < attempts) await sleep(delayMs);
    }
  }

  await monitor.appendEventLog(`SUB2API startup wait exhausted: ${lastError?.message || 'unknown error'}`);
  return false;
}

async function runLoop(options = {}) {
  const config = await monitor.loadConfig();
  if (!options.noLock) await monitor.acquireLock();
  let web = null;
  if (options.web !== false && !options.once) {
    web = await startWebServer({
      port: options.webPort,
    });
    process.stdout.write(`Web UI: ${web.url}\n`);
    await monitor.appendEventLog(`WEB server started ${web.url}`);
  }

  const runAndReport = async () => {
    try {
      const control = await monitor.readControl();
      if (control.autoCheckEnabled === false) {
        const checkedAt = monitor.nowBeijingIso();
        await monitor.appendLog(`[${checkedAt}] AUTO-CHECK paused; skipping scheduled check.`);
        if (!options.json) process.stdout.write(`[${checkedAt}] AUTO-CHECK paused; skipping scheduled check.\n`);
        return {
          checkedAt,
          ok: true,
          skipped: true,
          reason: 'auto-check paused',
        };
      }
      const ready = await waitForSub2apiReady(config, {
        attempts: options.once ? 1 : undefined,
      });
      if (!ready) {
        const summary = {
          checkedAt: monitor.nowBeijingIso(),
          failCount: 0,
          currentFailures: [],
          newFailures: [],
          changedFailures: [],
          recovered: [],
          ok: false,
          error: 'SUB2API is not ready.',
        };
        if (options.json) printJson(summary);
        else process.stdout.write(`[${summary.checkedAt}] SUB2API is not ready; will retry later.\n`);
        return summary;
      }
      const duplicateCleanup = await monitor.cleanupDuplicateFailedAccounts({ config });
      const summary = await monitor.checkOnce(config);
      const reloginResults = await reloginFailedAccounts(summary.currentFailures || [], {
        headless: options.headless,
      });
      const verifySummary = reloginResults.length ? await monitor.checkOnce(config) : null;
      const result = {
        ...summary,
        duplicateCleanup,
        reloginResults,
        verifySummary,
        ok: !verifySummary ? summary.failCount === 0 : verifySummary.failCount === 0,
      };
      if (options.json) {
        printJson(result);
        return result;
      }
      printMonitorSummary(summary, false);
      if (!options.json && duplicateCleanup.deletedCount) {
        process.stdout.write(`Deleted duplicate failed accounts: ${duplicateCleanup.deletedCount}\n`);
      }
      for (const item of reloginResults) {
        process.stdout.write(`AUTO-RELOGIN ${item.ok ? 'OK' : 'FAIL'} #${item.account?.id || '-'} ${item.email}: ${item.error || item.sessionPath || ''}\n`);
      }
      if (verifySummary) process.stdout.write(`After relogin: ${monitor.formatSummary(verifySummary)}\n`);
      return result;
    } catch (error) {
      const checkedAt = monitor.nowBeijingIso();
      await monitor.appendLog(`[${checkedAt}] ERROR ${error.stack || error.message || error}`);
      if (options.once) throw error;
      process.stdout.write(`[${checkedAt}] ERROR ${error.message || error}\n`);
      return {
        checkedAt,
        ok: false,
        error: error.message || String(error),
      };
    }
  };

  await runAndReport();
  if (options.once) return;

  const intervalMs = Math.max(1, Math.floor(config.intervalMinutes)) * 60 * 1000;
  process.stdout.write(`Next checks every ${Math.round(intervalMs / 60000)} minute(s).\n`);
  setInterval(() => {
    runAndReport().catch((error) => {
      console.error(error.stack || error.message || error);
    });
  }, intervalMs);
}

async function printStatus() {
  const config = await monitor.loadConfig();
  const [state, lock, legacyLock] = await Promise.all([
    monitor.readState(),
    monitor.readLock(monitor.LOCK_PATH),
    monitor.readLock(monitor.LEGACY_LOCK_PATH),
  ]);
  const accounts = loadAccounts();
  printJson({
    ok: true,
    sub2api: {
      groupNames: config.groupNames || [],
      latestFailCount: state.latestFailCount || 0,
      lastCheckedAt: state.lastCheckedAt || '',
      failAccounts: Object.values(state.failAccounts || {}).map((account) => ({
        id: account.id,
        name: account.name,
        status: account.status,
        groupNames: account.groupNames || [],
        errorMessage: account.errorMessage,
        updatedAt: account.updatedAt,
        lastSeenAt: account.lastSeenAt,
      })),
      lock: lock ? {
        pid: Number(lock.pid || 0),
        startedAt: lock.startedAt || '',
        alive: monitor.isPidAlive(Number(lock.pid || 0)),
      } : null,
      legacyLock: legacyLock ? {
        pid: Number(legacyLock.pid || 0),
        startedAt: legacyLock.startedAt || '',
        alive: monitor.isPidAlive(Number(legacyLock.pid || 0)),
      } : null,
    },
    mail: {
      accountStorePath: ACCOUNT_STORE_PATH,
      count: accounts.length,
      healthyKnown: accounts.filter((account) => account.status === 'authorized').length,
      failedKnown: accounts.filter((account) => account.status === 'error').length,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'status') {
    await printStatus();
    return;
  }

  if (command === 'run') {
    await runLoop({
      once: Boolean(args.once),
      json: Boolean(args.json),
      noLock: Boolean(args['no-lock']),
      web: args.web !== false && !args['no-web'],
      webPort: args.port || args['web-port'],
      headless: args.headless ? true : args['no-headless'] ? false : undefined,
    });
    return;
  }

  if (command === 'web') {
    const web = await startWebServer({
      port: args.port || args['web-port'],
    });
    process.stdout.write(`Web UI: ${web.url}\n`);
    await monitor.appendEventLog(`WEB server started ${web.url}`);
    await new Promise(() => {});
    return;
  }

  if (command === 'sub2api:check') {
    const summary = await monitor.checkOnce();
    printMonitorSummary(summary, Boolean(args.json));
    return;
  }

  if (command === 'sub2api:auto-check') {
    if (args.status || args._[1] === 'status') {
      printJson({ ok: true, ...(await monitor.readControl()) });
      return;
    }
    const value = args.enabled || args._[1];
    if (!/^(1|true|yes|on|enable|enabled|start|resume|0|false|no|off|disable|disabled|stop|pause)$/i.test(String(value || ''))) {
      throw new Error('Usage: node bin/auto-relogin.js sub2api:auto-check enable|disable|status');
    }
    const enabled = /^(1|true|yes|on|enable|enabled|start|resume)$/i.test(String(value));
    printJson({ ok: true, ...(await monitor.setAutoCheckEnabled(enabled, { updatedBy: 'cli' })) });
    return;
  }

  if (command === 'sub2api:cleanup-duplicates') {
    if (!args.apply) throw new Error('Refusing to delete without --apply.');
    const result = await monitor.cleanupDuplicateFailedAccounts();
    printDuplicateCleanupResult(result, Boolean(args.json));
    return;
  }

  if (command === 'cleanup:dead-mailbox') {
    const email = args.account || args.email || args._[1];
    if (!email || email === true) throw new Error('Missing --account email.');
    if (!args.apply) throw new Error('Refusing to delete without --apply.');
    const result = await browserRelogin.cleanupDeadMailbox(email, args.reason || 'manual cleanup');
    if (args.json) {
      printJson(result);
    } else {
      process.stdout.write(`Dead mailbox cleanup: mailDeleted=${result.mailDeleted}, sub2apiDeleted=${result.sub2apiDeleted}${result.sub2apiError ? `, sub2apiError=${result.sub2apiError}` : ''}\n`);
    }
    return;
  }

  if (command === 'session:convert') {
    const result = await sessionImporter.convertSessionFile(requirePathArg(args), {
      outputPath: args.out || args.output,
      email: args.email,
    });
    printSessionConvertResult(result, Boolean(args.json));
    return;
  }

  if (command === 'session:import') {
    const result = await sessionImporter.importSessionFile(requirePathArg(args), {
      email: args.email,
      name: args.name,
      notes: args.notes,
    });
    printImportResult(result, Boolean(args.json));
    return;
  }

  if (command === 'sub2api:import-json') {
    const result = await sessionImporter.importConvertedDocument(requirePathArg(args), {
      skipDefaultGroupBind: args['skip-default-group-bind'] !== false,
    });
    printImportResult(result, Boolean(args.json));
    return;
  }

  if (command === 'relogin:capture') {
    const email = args.account || args.email || args._[1];
    if (!email || email === true) throw new Error('Missing --account email.');
    const result = await browserRelogin.reloginAndCaptureSession(email, {
      headless: Boolean(args.headless),
      keepProfile: Boolean(args['keep-profile']),
      codeWaitMs: Number(args['code-wait-ms'] || 20000),
      debug: Boolean(args.debug),
    });
    printCaptureResult(result, Boolean(args.json));
    return;
  }

  if (command === 'relogin:import') {
    const email = args.account || args.email || args._[1];
    if (!email || email === true) throw new Error('Missing --account email.');
    const result = await browserRelogin.reloginImport(email, {
      headless: Boolean(args.headless),
      keepProfile: Boolean(args['keep-profile']),
      codeWaitMs: Number(args['code-wait-ms'] || 20000),
      debug: Boolean(args.debug),
    });
    printReloginImportResult(result, Boolean(args.json));
    return;
  }

  if (command === 'stop') {
    const current = await monitor.stopLockedProcess(monitor.LOCK_PATH);
    const legacy = await monitor.stopLockedProcess(monitor.LEGACY_LOCK_PATH);
    printJson({ ok: true, current, legacy });
    return;
  }

  if (command === 'mail:import') {
    const result = args.merge
      ? importFromGuJumpgateStorageMerge(args.from || DEFAULT_RAW_STORAGE_PATH)
      : importFromGuJumpgateStorage(args.from || DEFAULT_RAW_STORAGE_PATH);
    printJson({
      ok: true,
      accountStorePath: ACCOUNT_STORE_PATH,
      settingsStorePath: result.settingsStorePath,
      importedAccounts: result.imported || result.accounts.length,
      added: result.added,
      updated: result.updated,
      accounts: result.accounts.map(summarizeAccount),
    });
    return;
  }

  if (command === 'mail:import-lines') {
    const result = importFromHotmailAccountLineFile(requirePathArg(args));
    printJson({
      ok: result.errors.length === 0,
      inputPath: result.inputPath,
      accountStorePath: ACCOUNT_STORE_PATH,
      importedAccounts: result.imported,
      added: result.added,
      updated: result.updated,
      errors: result.errors,
      accounts: result.accounts.map(summarizeAccount),
    });
    return;
  }

  if (command === 'mail:list') {
    const accounts = loadAccounts();
    printJson({
      ok: true,
      accountStorePath: ACCOUNT_STORE_PATH,
      count: accounts.length,
      accounts: accounts.map(summarizeAccount),
    });
    return;
  }

  if (command === 'mail:delete') {
    if (!args.apply) throw new Error('Refusing to delete without --apply.');
    const result = deleteAccount(args.account || args.email || args._[1] || '');
    printJson({ ok: true, ...result });
    return;
  }

  if (command === 'mail:add') {
    const input = args.line
      ? parseHotmailAccountLine(args.line)
      : {
        email: args.email,
        password: args.password || '',
        clientId: args['client-id'] || args.clientId,
        refreshToken: args['refresh-token'] || args.refreshToken,
        status: 'pending',
        source: 'manual',
      };
    const account = upsertAccount(input);
    printJson({ ok: true, account: summarizeAccount(account) });
    return;
  }

  if (command === 'mail:check') {
    const result = await checkAccount(args.account || '', {
      top: Number(args.top || 5) || 5,
    });
    printJson(redactCheckResult(result));
    return;
  }

  if (command === 'mail:check-all') {
    const accounts = loadAccounts();
    const results = [];
    for (const account of accounts) {
      const result = await checkAccount(account.id, {
        top: Number(args.top || 3) || 3,
      });
      results.push(redactCheckResult(result));
    }
    printJson({
      ok: results.every((item) => item.ok),
      count: results.length,
      healthy: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    });
    return;
  }

  if (command === 'mail:latest-code') {
    const result = await getLatestVerificationCode(args.account || '', {
      kind: args.kind || 'login',
      top: Number(args.top || 10) || 10,
    });
    printJson(redactCodeResult(result));
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

process.on('exit', () => monitor.releaseLockSync(monitor.LOCK_PATH));
process.on('SIGINT', () => {
  monitor.releaseLockSync(monitor.LOCK_PATH);
  process.exit(130);
});
process.on('SIGTERM', () => {
  monitor.releaseLockSync(monitor.LOCK_PATH);
  process.exit(143);
});

main().catch((error) => {
  printJson({
    ok: false,
    error: error.message,
  });
  process.exitCode = 1;
});
