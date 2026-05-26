const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright-core');
const { getLatestVerificationCode } = require('./mail-client');
const accountStore = require('./account-store');
const monitor = require('./sub2api-monitor');
const sessionImporter = require('./sub2api-session-importer');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BROWSER_DATA_DIR = path.join(DATA_DIR, 'browser-profiles');
const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete*="email" i]',
  'input[id*="email" i]',
];
const CODE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[data-testid*="code" i]',
  'input[type="tel"]',
];
const PASSWORD_INPUT_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[id*="password" i]',
];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    '/ms-playwright/chromium-1200/chrome-linux/chrome',
    '/ms-playwright/chromium-1200/chrome-linux/chrome-wrapper',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    DEFAULT_CHROME_PATH,
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error('Chrome executable not found. Set CHROME_EXECUTABLE_PATH in .env.local.');
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
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || fallback;
}

async function createProfileDir(email) {
  await fs.mkdir(BROWSER_DATA_DIR, { recursive: true });
  const profileDir = path.join(BROWSER_DATA_DIR, `${sanitizeFileToken(email)}.${timestampToken()}`);
  await fs.mkdir(profileDir, { recursive: true });
  return profileDir;
}

async function removeProfileDir(profileDir) {
  if (!profileDir) return;
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

async function waitAndFetchCode(email, options = {}) {
  const waitMs = Number(options.waitMs || 20000);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return getLatestVerificationCode(email, {
    kind: 'login',
    top: Number(options.top || 10) || 10,
    filterAfterTimestamp: Number(options.filterAfterTimestamp || 0) || 0,
    excludeCodes: options.excludeCodes || [],
  });
}

function isMailboxDeadError(errorOrMessage) {
  const message = String(errorOrMessage?.message || errorOrMessage || '').toLowerCase();
  return [
    'invalid_grant',
    'refresh token',
    'unauthorized',
    'authentication',
    'auth',
    'invalid client',
    'account not found',
  ].some((needle) => message.includes(needle));
}

async function cleanupDeadMailbox(email, reason = '') {
  const mailDelete = accountStore.deleteAccount(email);
  const sub2apiDelete = await monitor.deleteSub2apiAccountsByEmail(email, {
    onlyError: false,
  }).catch((error) => ({
    count: 0,
    deleted: [],
    error: error.message,
  }));
  return {
    email,
    reason,
    mailDeleted: mailDelete.deleted,
    sub2apiDeleted: sub2apiDelete.count || 0,
    sub2apiError: sub2apiDelete.error || '',
  };
}

function isDeletedOrDeactivatedAccountText(text) {
  const message = String(text || '').toLowerCase();
  return [
    'account_deactivated',
    'deactivated',
    'deleted or deactivated',
    'account has been deleted or deactivated',
    '账户已被删除或停用',
    '帐号已被删除或停用',
    '账号已被删除或停用',
    '没有账户',
    '身份验证错误',
  ].some((needle) => message.includes(needle));
}

function isUnsupportedCountryRegionText(text) {
  const message = String(text || '').toLowerCase();
  return [
    'unsupported_country_region_territory',
    'unsupported country',
    'unsupported region',
    'country_region_territory',
  ].some((needle) => message.includes(needle));
}

function isRetryableSessionFetchError(errorOrMessage) {
  const message = String(errorOrMessage?.message || errorOrMessage || '').toLowerCase();
  return [
    'did not include accesstoken',
    'login may not be complete',
    'failed to parse chatgpt session json',
    'unexpected token',
    'unsupported_country_region_territory',
  ].some((needle) => message.includes(needle));
}

function detectLoginTextState(text) {
  const message = String(text || '').toLowerCase();
  if (isUnsupportedCountryRegionText(message)) return 'unsupported-region';
  if (isDeletedOrDeactivatedAccountText(message)) return 'deleted';
  if ([
    'check your email',
    'enter the code',
    'verification code',
    'temporary chatgpt login code',
    'we sent',
    'sent a code',
    'code sent',
    '验证码',
    '输入代码',
    '查看你的邮箱',
  ].some((needle) => message.includes(needle))) return 'code';
  if ([
    'password',
    'enter your password',
    '输入密码',
    '密码',
  ].some((needle) => message.includes(needle))) return 'password';
  if ([
    'captcha',
    'verify you are human',
    'are you human',
    'checking your browser',
    'unusual activity',
    'too many requests',
    'rate limit',
    'blocked',
    '人机',
    '真人',
    '验证你是真人',
  ].some((needle) => message.includes(needle))) return 'blocked';
  if ([
    'something went wrong',
    'try again later',
    'error',
    '出错',
    '稍后',
  ].some((needle) => message.includes(needle))) return 'error';
  return 'unknown';
}

async function detectDeletedOrDeactivatedAccount(page, debugDump = null) {
  const text = debugDump?.text || await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return isDeletedOrDeactivatedAccountText(text);
}

function proxyToPlaywright(proxy) {
  if (!proxy?.host || !proxy?.port) return null;
  const protocol = String(proxy.protocol || 'http').trim().toLowerCase() || 'http';
  const server = `${protocol}://${proxy.host}:${proxy.port}`;
  return {
    server,
    ...(proxy.username ? { username: String(proxy.username) } : {}),
    ...(proxy.password ? { password: String(proxy.password) } : {}),
  };
}

async function resolveBrowserProxy(options = {}) {
  if (options.proxy === false) return null;
  if (options.proxy && typeof options.proxy === 'object') {
    if (options.proxy.server) {
      return {
        server: String(options.proxy.server),
        ...(options.proxy.username ? { username: String(options.proxy.username) } : {}),
        ...(options.proxy.password ? { password: String(options.proxy.password) } : {}),
      };
    }
    return proxyToPlaywright(options.proxy);
  }
  if (options.useSub2apiProxy === true) {
    const config = await monitor.loadConfig();
    const { origin, token } = await monitor.login(config);
    return proxyToPlaywright(await monitor.resolveProxy(origin, token, config.proxyName));
  }
  const explicit = String(options.proxyServer || process.env.CHATGPT_RELOGIN_PROXY || '').trim();
  if (explicit === 'none') return null;
  if (explicit) {
    return {
      server: explicit,
      ...(options.proxyUsername || process.env.CHATGPT_RELOGIN_PROXY_USERNAME ? { username: String(options.proxyUsername || process.env.CHATGPT_RELOGIN_PROXY_USERNAME) } : {}),
      ...(options.proxyPassword || process.env.CHATGPT_RELOGIN_PROXY_PASSWORD ? { password: String(options.proxyPassword || process.env.CHATGPT_RELOGIN_PROXY_PASSWORD) } : {}),
    };
  }
  if (process.env.CHATGPT_RELOGIN_PROXY === 'none') return null;
  if (process.env.CHATGPT_RELOGIN_USE_SUB2API_PROXY === '0') return null;
  try {
    const config = await monitor.loadConfig();
    const { origin, token } = await monitor.login(config);
    return proxyToPlaywright(await monitor.resolveProxy(origin, token, config.proxyName));
  } catch {
    return null;
  }
}

function createPostCodeAuthErrorIfNeeded(debugDump) {
  const text = debugDump?.text || '';
  if (isUnsupportedCountryRegionText(text)) {
    const error = new Error('ChatGPT login hit unsupported_country_region_territory after code submit.');
    error.permanent = false;
    error.retryable = true;
    error.debug = debugDump;
    return error;
  }
  return null;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.max(1, count); index += 1) {
      const item = locator.nth(index);
      try {
        await item.waitFor({ state: 'visible', timeout: 1500 });
        await item.fill(value);
        return item;
      } catch {
        // Try the next matching node.
      }
    }
  }
  throw new Error(`No visible input found for selectors: ${selectors.join(', ')}`);
}

async function setInputValue(input, value) {
  await input.evaluate((element, nextValue) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(element, nextValue);
    } else {
      element.value = nextValue;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function submitNearestForm(locator) {
  return locator.evaluate((element) => {
    const form = element.closest('form');
    if (!form) return false;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    return true;
  }).catch(() => false);
}

async function clickFirstVisible(page, selectors, options = { forceFallback: true }) {
  let lastError = null;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.max(1, count); index += 1) {
      const item = locator.nth(index);
      try {
        await item.waitFor({ state: 'visible', timeout: 1500 });
        await item.click();
        return item;
      } catch (error) {
        lastError = error;
        if (options.forceFallback) {
          try {
            await item.click({ force: true, timeout: 5000 });
            return item;
          } catch (forceError) {
            lastError = forceError;
          }
          const clicked = await item.evaluate((element) => {
            element.click();
            return true;
          }).catch((evaluateError) => {
            lastError = evaluateError;
            return false;
          });
          if (clicked) return item;
        }
        // Try the next matching node.
      }
    }
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`No visible button found for selectors: ${selectors.join(', ')}${suffix}`);
}

async function gotoWithRetry(page, url, options = {}) {
  const attempts = Number(options.attempts || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, {
        waitUntil: options.waitUntil || 'domcontentloaded',
        timeout: options.timeout || 60000,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await page.waitForTimeout(Number(options.delayMs || 3000));
      }
    }
  }
  throw lastError;
}

async function debugDumpPage(page, label, options = {}) {
  if (!options.debugDir) return null;
  await fs.mkdir(options.debugDir, { recursive: true });
  const safeLabel = sanitizeFileToken(label, 'debug');
  const screenshotPath = path.join(options.debugDir, `${safeLabel}.png`);
  const textPath = path.join(options.debugDir, `${safeLabel}.txt`);
  const htmlPath = path.join(options.debugDir, `${safeLabel}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch((error) => error.message);
  const html = await page.content().catch((error) => error.message);
  await fs.writeFile(textPath, text, 'utf8').catch(() => {});
  await fs.writeFile(htmlPath, html, 'utf8').catch(() => {});
  return { screenshotPath, textPath, htmlPath, text };
}

async function isEmailInputVisible(page) {
  return page.locator(EMAIL_INPUT_SELECTORS.join(', '))
    .first()
    .isVisible()
    .catch(() => false);
}

async function isCodeInputVisible(page) {
  return page.locator(CODE_INPUT_SELECTORS.join(', '))
    .first()
    .isVisible()
    .catch(() => false);
}

async function isPasswordInputVisible(page) {
  return page.locator(PASSWORD_INPUT_SELECTORS.join(', '))
    .first()
    .isVisible()
    .catch(() => false);
}

async function getLoginPageState(page) {
  const [emailVisible, codeVisible, passwordVisible, text] = await Promise.all([
    isEmailInputVisible(page),
    isCodeInputVisible(page),
    isPasswordInputVisible(page),
    page.locator('body').innerText({ timeout: 3000 }).catch(() => ''),
  ]);
  const textState = detectLoginTextState(text);
  let state = 'unknown';
  if (codeVisible || textState === 'code') state = 'code';
  else if (passwordVisible || textState === 'password') state = 'password';
  else if (textState === 'unsupported-region') state = 'unsupported-region';
  else if (textState === 'deleted') state = 'deleted';
  else if (textState === 'blocked') state = 'blocked';
  else if (textState === 'error') state = 'error';
  else if (emailVisible) state = 'email';
  else if (/chatgpt\.com\/?($|[?#])/.test(page.url()) && !/auth|login/i.test(page.url())) state = 'maybe-authenticated';
  return {
    state,
    emailVisible,
    codeVisible,
    passwordVisible,
    textState,
    url: page.url(),
  };
}

async function waitForEmailStepAdvance(page, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 45000);
  const startedAt = Date.now();
  let lastState = { state: 'unknown', emailVisible: false, codeVisible: false, passwordVisible: false, url: page.url() };
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await getLoginPageState(page);
    if (['code', 'password', 'deleted', 'error', 'unsupported-region', 'maybe-authenticated'].includes(lastState.state)) {
      return {
        advanced: lastState.state === 'code' || lastState.state === 'maybe-authenticated',
        ...lastState,
      };
    }
    await page.waitForTimeout(1000);
  }
  return { advanced: false, ...lastState };
}

async function reloadLoginStep(page) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch {
    await gotoWithRetry(page, 'https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForTimeout(1500);
  const state = await getLoginPageState(page);
  if (state.state !== 'email' && state.state !== 'code') {
    await gotoWithRetry(page, 'https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' });
  }
}

async function submitEmailWithRetries(page, email, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 5));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000));
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) await reloadLoginStep(page);
    await debugDumpPage(page, attempt === 1 ? '01-login' : `01-login-retry-${attempt}`, {
      debugDir: options.debugDir,
    });
    try {
      await submitEmail(page, email);
    } catch (error) {
      const dump = await debugDumpPage(page, attempt === 1 ? '02-after-email-submit-error' : `02-after-email-submit-error-retry-${attempt}`, {
        debugDir: options.debugDir,
      });
      const state = await getLoginPageState(page).catch(() => ({
        state: 'submit-error',
        url: page.url(),
      }));
      lastResult = {
        advanced: false,
        attempt,
        emailAdvance: {
          ...state,
          state: state.state === 'unknown' ? 'submit-error' : state.state,
          error: error.message,
        },
        dump,
      };
      if (await detectDeletedOrDeactivatedAccount(page, dump)) {
        const cleanup = await cleanupDeadMailbox(email, 'chatgpt_account_deleted_or_deactivated');
        const cleanupError = new Error('ChatGPT account is deleted/deactivated and was cleaned up.');
        cleanupError.cleanup = cleanup;
        cleanupError.permanent = true;
        throw cleanupError;
      }
      continue;
    }
    const emailAdvance = await waitForEmailStepAdvance(page, { timeoutMs });
    const dump = await debugDumpPage(page, attempt === 1 ? '02-after-email-submit' : `02-after-email-submit-retry-${attempt}`, {
      debugDir: options.debugDir,
    });
    if (await detectDeletedOrDeactivatedAccount(page, dump)) {
      const cleanup = await cleanupDeadMailbox(email, 'chatgpt_account_deleted_or_deactivated');
      const error = new Error('ChatGPT account is deleted/deactivated and was cleaned up.');
      error.cleanup = cleanup;
      error.permanent = true;
      throw error;
    }
    lastResult = { advanced: emailAdvance.advanced, attempt, emailAdvance, dump };
    if (emailAdvance.state === 'password') {
      const error = new Error('ChatGPT login reached a password step instead of email-code login.');
      error.debug = dump;
      error.emailAdvance = emailAdvance;
      throw error;
    }
    if (emailAdvance.state === 'blocked' || emailAdvance.state === 'error' || emailAdvance.state === 'unsupported-region') {
      continue;
    }
    if (emailAdvance.advanced) return lastResult;
  }

  return lastResult || { advanced: false, attempt: 0, emailAdvance: null, dump: null };
}

async function submitEmail(page, email) {
  const input = await fillFirstVisible(page, EMAIL_INPUT_SELECTORS, '');
  await input.click();
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(email, { delay: 35 });
  await setInputValue(input, email).catch(() => {});
  const currentValue = await input.evaluate((element) => element.value).catch(() => '');
  if (String(currentValue || '').trim().toLowerCase() !== String(email || '').trim().toLowerCase()) {
    await input.fill(email);
    await setInputValue(input, email).catch(() => {});
    await page.waitForTimeout(300);
  }
  await input.blur().catch(() => {});
  await page.waitForTimeout(500);
  await input.press('Enter').catch(() => {});
  await page.waitForTimeout(3000);
  const stillOnEmail = await isEmailInputVisible(page);
  if (stillOnEmail) {
    await clickFirstVisible(page, [
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("继续")',
      'button:has-text("Next")',
    ]);
  }
}

async function submitCode(page, code) {
  const visibleDigitInputs = [];
  const digitInputs = await page.locator(CODE_INPUT_SELECTORS.join(', ')).all();
  for (const input of digitInputs) {
    if (await input.isVisible().catch(() => false)) visibleDigitInputs.push(input);
  }
  if (visibleDigitInputs.length > 1) {
    for (let index = 0; index < Math.min(code.length, visibleDigitInputs.length); index += 1) {
      await visibleDigitInputs[index].fill(code[index]);
    }
  } else {
    const input = await fillFirstVisible(page, [...CODE_INPUT_SELECTORS, 'input[type="text"]'], code);
    await setInputValue(input, code).catch(() => {});
  }
  await clickFirstVisible(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Verify")',
    'button:has-text("继续")',
    'button:has-text("验证")',
  ]).catch(() => {});
}

async function fetchSessionFromPage(page) {
  const attempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.goto('https://chatgpt.com/api/auth/session', { waitUntil: 'networkidle', timeout: 60000 });
    const text = await page.locator('body').innerText({ timeout: 30000 });
    let session;
    try {
      session = JSON.parse(text);
    } catch (error) {
      lastError = new Error(`Failed to parse ChatGPT session JSON: ${error.message}`);
      session = null;
    }
    if (session?.accessToken || session?.access_token) {
      return session;
    }
    lastError = new Error('ChatGPT session JSON did not include accessToken. Login may not be complete.');
    if (attempt < attempts) {
      await page.waitForTimeout(3000);
    }
  }
  throw lastError;
}

async function reloginAndCaptureSession(email, options = {}) {
  const chromePath = await findChromeExecutable();
  const profileDir = await createProfileDir(email);
  let context;
  const headless = Boolean(options.headless);
  const browserProxy = await resolveBrowserProxy(options);
  const postCodeMaxAttempts = Math.max(1, Number(options.postCodeMaxAttempts || process.env.CHATGPT_RELOGIN_POST_CODE_MAX_ATTEMPTS || 3));
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-ipv6',
      ...(headless ? [
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-features=Vulkan,VulkanFromANGLE',
      '--use-gl=swiftshader',
      '--use-angle=swiftshader',
      '--disable-background-networking',
    ] : []),
  ];
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromePath,
      headless,
      viewport: { width: 1280, height: 900 },
      args: launchArgs,
      ...(browserProxy ? { proxy: browserProxy } : {}),
    });
    const page = context.pages()[0] || await context.newPage();
    const debugDir = options.debugDir || (options.debug ? path.join(DATA_DIR, 'debug-login', `${sanitizeFileToken(email)}.${timestampToken()}`) : '');
    let lastRetryableError = null;

    for (let attempt = 1; attempt <= postCodeMaxAttempts; attempt += 1) {
      const attemptStartedAt = Date.now();
      const attemptPrefix = postCodeMaxAttempts > 1 ? `attempt-${attempt}-` : '';
      if (attempt > 1) {
        await gotoWithRetry(page, 'https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
      }

      await gotoWithRetry(page, 'https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' });
      const emailSubmit = await submitEmailWithRetries(page, email, {
        debugDir,
        maxAttempts: options.emailStepMaxAttempts,
        timeoutMs: options.emailStepTimeoutMs,
      });
      if (!emailSubmit.advanced) {
        const state = emailSubmit.emailAdvance?.state || 'unknown';
        lastRetryableError = new Error(`ChatGPT login did not reach email-code step after email submit. Last state: ${state}.`);
        lastRetryableError.debug = emailSubmit.dump;
        lastRetryableError.emailAdvance = emailSubmit.emailAdvance;
        lastRetryableError.attempt = emailSubmit.attempt;
        lastRetryableError.retryable = true;
        if (attempt < postCodeMaxAttempts) continue;
        throw lastRetryableError;
      }

      let codeResult = await waitAndFetchCode(email, {
        waitMs: options.codeWaitMs,
        filterAfterTimestamp: attemptStartedAt,
      });
      if (!codeResult.ok || !codeResult.code) {
        codeResult = await waitAndFetchCode(email, {
          waitMs: 0,
          filterAfterTimestamp: 0,
        });
      }
      if (!codeResult.ok || !codeResult.code) {
        if (isMailboxDeadError(codeResult.error)) {
          const cleanup = await cleanupDeadMailbox(email, codeResult.error);
          const error = new Error(`Mailbox appears invalid and was cleaned up: ${codeResult.error}`);
          error.cleanup = cleanup;
          throw error;
        }
        throw new Error(codeResult.error || 'No ChatGPT verification code found.');
      }

      await submitCode(page, codeResult.code);
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const afterCodeDump = await debugDumpPage(page, `${attemptPrefix}03-after-code-submit`, { debugDir });
      const postCodeAuthError = createPostCodeAuthErrorIfNeeded(afterCodeDump);
      if (postCodeAuthError) {
        lastRetryableError = postCodeAuthError;
        if (attempt < postCodeMaxAttempts) continue;
        throw postCodeAuthError;
      }
      if (await detectDeletedOrDeactivatedAccount(page, afterCodeDump)) {
        const cleanup = await cleanupDeadMailbox(email, 'chatgpt_account_deleted_or_deactivated');
        const error = new Error('ChatGPT account is deleted/deactivated and was cleaned up.');
        error.cleanup = cleanup;
        error.permanent = true;
        throw error;
      }

      try {
        const session = await fetchSessionFromPage(page);
        const sessionPath = await sessionImporter.saveCapturedSession(email, session, options);
        return {
          ok: true,
          email,
          sessionPath,
          codeMailbox: codeResult.mailbox || codeResult.message?.mailbox || '',
          codeReceivedAt: codeResult.message?.receivedDateTime || '',
          profileDir,
          loginAttempts: attempt,
          proxyServer: browserProxy?.server || '',
        };
      } catch (error) {
        if (!isRetryableSessionFetchError(error) || attempt >= postCodeMaxAttempts) {
          throw error;
        }
        lastRetryableError = error;
      }
    }

    throw lastRetryableError || new Error('ChatGPT login did not complete.');
  } finally {
    if (context) await context.close().catch(() => {});
    if (options.keepProfile !== true) await removeProfileDir(profileDir);
  }
}

async function reloginImport(email, options = {}) {
  const capture = await reloginAndCaptureSession(email, options);
  const preImportCleanup = await monitor.deleteSub2apiAccountsByEmail(email, {
    onlyError: true,
  });
  const importResult = await sessionImporter.importSessionFile(capture.sessionPath, {
    email,
    name: email,
  });
  return {
    ok: capture.ok && importResult.ok,
    capture,
    preImportCleanup,
    import: sessionImporter.summarizeImportResult(importResult),
  };
}

module.exports = {
  BROWSER_DATA_DIR,
  cleanupDeadMailbox,
  detectDeletedOrDeactivatedAccount,
  findChromeExecutable,
  isDeletedOrDeactivatedAccountText,
  isMailboxDeadError,
  reloginAndCaptureSession,
  reloginImport,
};
