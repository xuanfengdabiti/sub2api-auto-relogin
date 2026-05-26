const state = {
  accounts: [],
  selected: new Set(),
  logs: [],
  busy: false,
  autoCheckEnabled: true,
};

const $ = (selector) => document.querySelector(selector);

const els = {
  statTotal: $('#statTotal'),
  statOk: $('#statOk'),
  statError: $('#statError'),
  statFail: $('#statFail'),
  subtitle: $('#subtitle'),
  lastChecked: $('#lastChecked'),
  accountsBody: $('#accountsBody'),
  selectedCount: $('#selectedCount'),
  importText: $('#importText'),
  importResult: $('#importResult'),
  reloginProxyMode: $('#reloginProxyMode'),
  customProxyFields: $('#customProxyFields'),
  proxyServer: $('#proxyServer'),
  proxyUsername: $('#proxyUsername'),
  proxyPassword: $('#proxyPassword'),
  reloginResult: $('#reloginResult'),
  searchInput: $('#searchInput'),
  selectAll: $('#selectAll'),
  logsBox: $('#logsBox'),
  autoCheckStatus: $('#autoCheckStatus'),
  autoCheckToggleBtn: $('#autoCheckToggleBtn'),
  toast: $('#toast'),
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}

function setBusy(isBusy) {
  state.busy = isBusy;
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = isBusy;
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function formatTime(value) {
  if (!value) return '-';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!time) return '-';
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function statusText(status) {
  if (status === 'authorized') return '正常';
  if (status === 'error') return '异常';
  if (status === 'pending') return '待检测';
  return status || '未知';
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function filteredAccounts() {
  const query = els.searchInput.value.trim().toLowerCase();
  if (!query) return state.accounts;
  return state.accounts.filter((account) => [
    account.email,
    account.status,
    account.source,
    account.lastError,
  ].some((value) => String(value || '').toLowerCase().includes(query)));
}

function selectedEmails() {
  return [...state.selected]
    .map((id) => state.accounts.find((account) => account.id === id)?.email)
    .filter(Boolean);
}

function updateSelectionLabel() {
  const count = state.selected.size;
  els.selectedCount.textContent = count ? `已选 ${count} 个` : '未选择';
  const visible = filteredAccounts();
  els.selectAll.checked = visible.length > 0 && visible.every((account) => state.selected.has(account.id));
  els.selectAll.indeterminate = visible.some((account) => state.selected.has(account.id)) && !els.selectAll.checked;
}

function renderAccounts() {
  const accounts = filteredAccounts();
  if (!accounts.length) {
    els.accountsBody.innerHTML = '<tr><td colspan="6" class="empty">没有匹配的邮箱</td></tr>';
    updateSelectionLabel();
    return;
  }

  els.accountsBody.innerHTML = accounts.map((account) => `
    <tr>
      <td class="select-col">
        <input class="row-check" type="checkbox" data-id="${escapeHtml(account.id)}" ${state.selected.has(account.id) ? 'checked' : ''}>
      </td>
      <td>
        <div class="email-cell">${escapeHtml(account.email)}</div>
        <div class="hint">${account.hasPassword ? 'password' : 'no password'} / ${account.hasClientId ? 'clientId' : 'no clientId'} / ${account.hasRefreshToken ? 'token' : 'no token'}</div>
      </td>
      <td><span class="status ${escapeHtml(account.status)}">${escapeHtml(statusText(account.status))}</span></td>
      <td class="mono">${escapeHtml(formatTime(account.lastAuthAt))}</td>
      <td><div class="error-text" title="${escapeHtml(account.lastError || '')}">${escapeHtml(account.lastError || '-')}</div></td>
      <td>
        <div class="actions">
          <button data-action="check" data-id="${escapeHtml(account.id)}">检测</button>
          <button data-action="code" data-id="${escapeHtml(account.id)}">复制验证码</button>
          <button data-action="delete" data-id="${escapeHtml(account.id)}" class="danger">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
  updateSelectionLabel();
}

function applyAutoCheckStatus(sub2api) {
  const enabled = sub2api.autoCheckEnabled !== false;
  state.autoCheckEnabled = enabled;
  els.autoCheckStatus.textContent = enabled ? '自动检测：运行中' : '自动检测：已暂停';
  els.autoCheckStatus.classList.toggle('paused', !enabled);
  els.autoCheckToggleBtn.textContent = enabled ? '暂停检测' : '开启检测';
  els.autoCheckToggleBtn.dataset.enabled = String(enabled);
  els.autoCheckToggleBtn.classList.toggle('paused', !enabled);
  els.autoCheckToggleBtn.setAttribute('aria-pressed', String(!enabled));
}

function applyStatus(payload) {
  state.accounts = payload.mail.accounts || [];
  const ids = new Set(state.accounts.map((account) => account.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  applyAutoCheckStatus(payload.sub2api || {});

  els.statTotal.textContent = payload.mail.count || 0;
  els.statOk.textContent = payload.mail.authorized || 0;
  els.statError.textContent = payload.mail.error || 0;
  els.statFail.textContent = payload.sub2api.latestFailCount || 0;
  els.subtitle.textContent = `group=${(payload.sub2api.groupNames || []).join(',') || '-'} / every ${payload.sub2api.intervalMinutes || '-'} min / web ${payload.web?.port || 8083}`;
  els.lastChecked.textContent = payload.sub2api.lastCheckedAt
    ? `上次检测 ${formatTime(payload.sub2api.lastCheckedAt)}`
    : '还没有检测记录';
  renderAccounts();
}

async function refreshStatus() {
  const payload = await api('/api/status');
  applyStatus(payload);
}

async function refreshLogs() {
  const payload = await api('/api/logs?lines=260');
  state.logs = payload.lines || [];
  els.logsBox.textContent = state.logs.length ? state.logs.join('\n') : '暂无日志';
  els.logsBox.scrollTop = els.logsBox.scrollHeight;
}

async function runAction(label, fn) {
  if (state.busy) return;
  try {
    setBusy(true);
    showToast(`${label}...`);
    await fn();
    await Promise.all([refreshStatus(), refreshLogs()]);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function importLines() {
  const text = els.importText.value.trim();
  if (!text) {
    showToast('先粘贴邮箱数据');
    return;
  }
  await runAction('正在导入', async () => {
    const result = await api('/api/mail/import-lines', {
      method: 'POST',
      body: { text },
    });
    els.importResult.textContent = `导入 ${result.imported} 条，新增 ${result.added}，更新 ${result.updated}，错误 ${result.errors.length}`;
    if (result.errors.length) {
      showToast(`有 ${result.errors.length} 行没有导入`);
    } else {
      showToast('导入完成');
    }
  });
}

async function checkEmails(emails) {
  if (!emails.length) {
    showToast('没有可检测的邮箱');
    return;
  }
  await runAction('正在检测邮箱', async () => {
    const result = await api('/api/mail/check', {
      method: 'POST',
      body: { emails },
    });
    showToast(`检测完成：${result.results.filter((item) => item.ok).length}/${result.results.length} 正常`);
  });
}

async function deleteEmails(emails) {
  if (!emails.length) {
    showToast('没有可删除的邮箱');
    return;
  }
  const deleteSub2api = $('#deleteSub2api').checked;
  const message = deleteSub2api
    ? `确认删除 ${emails.length} 个邮箱，并同步删除 SUB2API 账号？`
    : `确认删除 ${emails.length} 个本地邮箱？`;
  if (!window.confirm(message)) return;
  await runAction('正在删除', async () => {
    await api('/api/mail/delete', {
      method: 'POST',
      body: { emails, deleteSub2api },
    });
    for (const account of state.accounts) {
      if (emails.includes(account.email)) state.selected.delete(account.id);
    }
    showToast('删除完成');
  });
}

async function copyLatestCode(account) {
  await runAction('正在获取验证码', async () => {
    const result = await api('/api/mail/latest-code', {
      method: 'POST',
      body: { email: account.email, kind: 'login' },
    });
    if (!result.code) throw new Error(result.error || '没有找到验证码');
    await navigator.clipboard.writeText(result.code);
    showToast(`验证码已复制：${result.code}`);
  });
}

function reloginProxyPayload() {
  const proxyMode = els.reloginProxyMode.value;
  const payload = { proxyMode };
  if (proxyMode === 'custom') {
    payload.proxyServer = els.proxyServer.value.trim();
    payload.proxyUsername = els.proxyUsername.value.trim();
    payload.proxyPassword = els.proxyPassword.value;
    if (!payload.proxyServer) throw new Error('先填写代理地址');
  }
  return payload;
}

async function reloginEmails(emails) {
  if (!emails.length) {
    showToast('没有可重登的邮箱');
    return;
  }
  let payload;
  try {
    payload = reloginProxyPayload();
  } catch (error) {
    showToast(error.message);
    return;
  }
  const proxyLabel = els.reloginProxyMode.options[els.reloginProxyMode.selectedIndex]?.textContent || '';
  const message = `确认重登 ${emails.length} 个邮箱并导入 SUB2API？\n登录代理：${proxyLabel}`;
  if (!window.confirm(message)) return;
  await runAction('正在重登并导入', async () => {
    const result = await api('/api/relogin/import', {
      method: 'POST',
      body: {
        emails,
        ...payload,
      },
    });
    const failed = result.results.filter((item) => !item.ok);
    els.reloginResult.textContent = `完成 ${result.successCount}/${result.reloginCount} 个${failed.length ? `，失败：${failed.map((item) => item.email).join(', ')}` : ''}`;
    showToast(failed.length ? `重登完成，有 ${failed.length} 个失败` : '重登并导入完成');
  });
}

async function toggleAutoCheck() {
  const nextEnabled = !state.autoCheckEnabled;
  await runAction(nextEnabled ? '正在开启自动检测' : '正在暂停自动检测', async () => {
    const result = await api('/api/sub2api/auto-check', {
      method: 'POST',
      body: { enabled: nextEnabled },
    });
    applyAutoCheckStatus(result);
    showToast(nextEnabled ? '自动检测已开启' : '自动检测已暂停');
  });
}

function bindEvents() {
  $('#refreshBtn').addEventListener('click', () => runAction('正在刷新', async () => {
    await Promise.all([refreshStatus(), refreshLogs()]);
    showToast('已刷新');
  }));

  els.autoCheckToggleBtn.addEventListener('click', toggleAutoCheck);

  $('#sub2apiCheckBtn').addEventListener('click', () => runAction('正在检测 Sub2API', async () => {
    await api('/api/sub2api/check', { method: 'POST' });
    showToast('Sub2API 检测完成');
  }));

  $('#importBtn').addEventListener('click', importLines);
  $('#clearImportBtn').addEventListener('click', () => {
    els.importText.value = '';
    els.importResult.textContent = '';
  });

  $('#checkSelectedBtn').addEventListener('click', () => checkEmails(selectedEmails()));
  $('#checkAllBtn').addEventListener('click', () => checkEmails(state.accounts.map((account) => account.email)));
  $('#deleteSelectedBtn').addEventListener('click', () => deleteEmails(selectedEmails()));
  $('#deleteAllBtn').addEventListener('click', () => deleteEmails(state.accounts.map((account) => account.email)));
  $('#reloginSelectedBtn').addEventListener('click', () => reloginEmails(selectedEmails()));

  els.reloginProxyMode.addEventListener('change', () => {
    els.customProxyFields.classList.toggle('hidden', els.reloginProxyMode.value !== 'custom');
  });

  $('#copyLogsBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.logs.join('\n'));
    showToast('日志已复制');
  });

  els.searchInput.addEventListener('input', renderAccounts);

  els.selectAll.addEventListener('change', () => {
    const visible = filteredAccounts();
    if (els.selectAll.checked) {
      visible.forEach((account) => state.selected.add(account.id));
    } else {
      visible.forEach((account) => state.selected.delete(account.id));
    }
    renderAccounts();
  });

  els.accountsBody.addEventListener('change', (event) => {
    if (!event.target.classList.contains('row-check')) return;
    const id = event.target.dataset.id;
    if (event.target.checked) state.selected.add(id);
    else state.selected.delete(id);
    updateSelectionLabel();
  });

  els.accountsBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const account = state.accounts.find((item) => item.id === button.dataset.id);
    if (!account) return;
    if (button.dataset.action === 'check') checkEmails([account.email]);
    if (button.dataset.action === 'code') copyLatestCode(account);
    if (button.dataset.action === 'delete') deleteEmails([account.email]);
  });
}

async function init() {
  bindEvents();
  try {
    await Promise.all([refreshStatus(), refreshLogs()]);
  } catch (error) {
    showToast(error.message);
  }
  setInterval(() => {
    Promise.all([refreshStatus(), refreshLogs()]).catch(() => {});
  }, 30000);
}

init();
