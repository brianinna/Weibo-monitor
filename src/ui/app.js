let config = null;

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getWeclawConfig() {
  if (!config.notifications) config.notifications = {};
  if (!config.notifications.weclaw) {
    config.notifications.weclaw = {
      enabled: false,
      apiUrl: 'http://127.0.0.1:18011/api/send',
      to: '',
      sendImages: true
    };
  }
  return config.notifications.weclaw;
}

function renderUsers() {
  const list = $('userList');
  list.innerHTML = '';
  for (const user of config.users) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <span>${escapeHtml(user.name || user.id)}</span>
      <span>${escapeHtml(user.url || user.id)}</span>
      <button class="secondary" data-action="view" data-id="${escapeHtml(user.id)}">查看本地库</button>
      <button class="secondary" data-action="delete" data-id="${escapeHtml(user.id)}">删除</button>
    `;
    row.querySelector('[data-action="view"]').addEventListener('click', () => {
      loadLocalPosts(user);
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      config.users = config.users.filter((item) => item.id !== user.id);
      renderUsers();
    });
    list.appendChild(row);
  }
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function loadLocalPosts(user) {
  const data = await api(`/api/posts?uid=${encodeURIComponent(user.id)}`);
  $('localPostsTitle').textContent = `${user.name || user.id}：本地保存 ${data.posts.length} 条`;
  const box = $('localPosts');
  box.innerHTML = '';
  for (const post of data.posts) {
    const item = document.createElement('article');
    item.className = 'post-item';
    const img = post.screenshot
      ? `<img class="post-image" src="/api/screenshot?file=${encodeURIComponent(post.screenshot)}" alt="微博截图" loading="lazy" />`
      : '';
    item.innerHTML = `
      <div class="post-body">
        <div class="post-meta">
          <span>${escapeHtml(formatTime(post.createdAt))}</span>
          <a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">打开微博</a>
          <span>${escapeHtml(post.id)}</span>
        </div>
        <div class="post-text">${escapeHtml(post.text || '')}</div>
      </div>
      ${img}
    `;
    box.appendChild(item);
  }
}

function fillForm() {
  $('browserType').value = config.browser.type || 'auto';
  $('debugPort').value = config.browser.remoteDebuggingPort || 9222;
  $('profileDirectory').value = config.browser.profileDirectory || 'Default';
  $('interval').value = config.monitor.checkIntervalSeconds || 300;
  $('maxPosts').value = config.monitor.maxPostsPerUser || 5;
  $('maxScanPages').value = config.monitor.maxScanPages || 3;
  $('notifyFirst').checked = Boolean(config.monitor.notifyOnFirstRun);
  const weclaw = getWeclawConfig();
  $('notifyWeclawEnabled').checked = Boolean(weclaw.enabled);
  $('notifyImages').checked = weclaw.sendImages !== false;
  $('weclawApiUrl').value = weclaw.apiUrl || 'http://127.0.0.1:18011/api/send';
  $('weclawTo').value = weclaw.to || '';
  renderUsers();
}

function collectForm() {
  config.browser.type = $('browserType').value;
  config.browser.remoteDebuggingPort = Number($('debugPort').value || 9222);
  config.browser.profileDirectory = $('profileDirectory').value || 'Default';
  config.monitor.checkIntervalSeconds = Number($('interval').value || 300);
  config.monitor.maxPostsPerUser = Number($('maxPosts').value || 5);
  config.monitor.maxScanPages = Number($('maxScanPages').value || 3);
  config.monitor.notifyOnFirstRun = $('notifyFirst').checked;
  const weclaw = getWeclawConfig();
  weclaw.enabled = $('notifyWeclawEnabled').checked;
  weclaw.sendImages = $('notifyImages').checked;
  weclaw.apiUrl = $('weclawApiUrl').value.trim() || 'http://127.0.0.1:18011/api/send';
  weclaw.to = $('weclawTo').value.trim();
}

async function saveConfig(showStatus = true) {
  collectForm();
  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(config) });
  config = data.config;
  if (showStatus) $('loginStatus').textContent = '配置已保存';
}

function showLoginScreenshot(data) {
  if (!data || !data.screenshotUrl) return;
  $('loginShot').src = data.screenshotUrl;
  $('loginShotBox').classList.remove('hidden');
}

async function loadProfiles() {
  const data = await api('/api/profiles');
  const select = $('profileSelect');
  select.innerHTML = '<option value="managed">应用隔离 Profile（推荐）</option><option value="">手动填写</option>';
  for (const profile of data.profiles || []) {
    const option = document.createElement('option');
    option.value = JSON.stringify(profile);
    option.textContent = `${profile.browser} - ${profile.label}`;
    if (
      profile.profileDirectory === config.browser.profileDirectory &&
      (!config.browser.userDataDir || profile.userDataDir === config.browser.userDataDir)
    ) {
      option.selected = true;
    }
    select.appendChild(option);
  }
}

async function loadLogs() {
  const data = await api('/api/logs');
  $('checkResult').textContent = (data.logs || []).join('\n');
}

async function init() {
  config = await api('/api/config');
  fillForm();
  await loadProfiles();

  $('profileSelect').addEventListener('change', () => {
    if ($('profileSelect').value === 'managed') {
      config.browser.type = 'chrome';
      config.browser.executablePath = null;
      config.browser.userDataDir = '%LOCALAPPDATA%\\WeiboMonitor\\ChromeProfile';
      config.browser.profileDirectory = 'Default';
      fillForm();
      $('profileHint').textContent = '当前使用应用隔离 Profile，不影响日常 Chrome。';
      return;
    }
    if (!$('profileSelect').value) {
      $('profileHint').textContent = '手动模式会按下方配置启动浏览器。';
      return;
    }
    const profile = JSON.parse($('profileSelect').value);
    config.browser.type = profile.browser;
    config.browser.executablePath = profile.executablePath;
    config.browser.userDataDir = profile.userDataDir;
    config.browser.profileDirectory = profile.profileDirectory;
    fillForm();
    $('profileHint').textContent = '当前选择的是系统浏览器 Profile。若这个 Chrome 已经普通方式打开，调试端口可能无法生效。';
  });

  $('refreshProfilesBtn').addEventListener('click', loadProfiles);
  $('saveBtn').addEventListener('click', saveConfig);

  $('addUserBtn').addEventListener('click', async () => {
    const input = $('userInput').value.trim();
    const parsed = await api('/api/users/parse', { method: 'POST', body: JSON.stringify({ input }) });
    if (!config.users.some((user) => user.id === parsed.id)) {
      config.users.push({
        id: parsed.id,
        name: $('userName').value.trim() || parsed.id,
        url: parsed.url
      });
    }
    $('userInput').value = '';
    $('userName').value = '';
    renderUsers();
  });

  $('openBrowserBtn').addEventListener('click', async () => {
    await saveConfig();
    $('loginStatus').textContent = '正在打开微博登录页并截图...';
    const data = await api('/api/browser/open', { method: 'POST', body: '{}' });
    showLoginScreenshot(data);
    $('loginStatus').textContent = '已生成登录截图，扫码后点击检测登录';
  });

  $('refreshLoginShotBtn').addEventListener('click', async () => {
    $('loginStatus').textContent = '正在刷新登录截图...';
    const data = await api('/api/browser/open', { method: 'POST', body: '{}' });
    showLoginScreenshot(data);
    $('loginStatus').textContent = '登录截图已刷新';
  });

  $('checkLoginBtn').addEventListener('click', async () => {
    await saveConfig();
    $('loginStatus').textContent = '正在检测登录...';
    const data = await api('/api/login/check', { method: 'POST', body: '{}' });
    $('loginStatus').textContent = data.loggedIn ? '已检测到微博登录态' : '未检测到登录态，请打开微博登录页';
  });

  $('checkNowBtn').addEventListener('click', async () => {
    await saveConfig();
    $('checkResult').textContent = '正在检查，会打开每个监控用户的微博主页...';
    try {
      const data = await api('/api/check', { method: 'POST', body: '{}' });
      $('checkResult').textContent = JSON.stringify(data.results, null, 2);
    } catch (error) {
      $('checkResult').textContent = error.message;
    }
  });

  $('showLogsBtn').addEventListener('click', async () => {
    await loadLogs();
  });

  $('startWeclawBtn').addEventListener('click', async () => {
    await saveConfig();
    $('weclawStatus').textContent = '正在启动 WeClaw...';
    try {
      const data = await api('/api/weclaw/start', { method: 'POST', body: '{}' });
      $('weclawStatus').textContent = data.message || (data.started ? 'WeClaw 已启动，请在日志中扫码' : 'WeClaw 已在运行');
      await loadLogs();
    } catch (error) {
      $('weclawStatus').textContent = error.message;
    }
  });

  $('detectWeclawToBtn').addEventListener('click', async () => {
    $('weclawStatus').textContent = '正在读取 WeClaw 最近发信人...';
    try {
      const data = await api('/api/weclaw/last-sender');
      $('weclawTo').value = data.to;
      getWeclawConfig().to = data.to;
      await saveConfig(false);
      $('weclawStatus').textContent = `已填入并保存接收人 ID：${data.to}`;
    } catch (error) {
      $('weclawStatus').textContent = error.message;
    }
  });

  $('checkWeclawBtn').addEventListener('click', async () => {
    await saveConfig();
    $('weclawStatus').textContent = '正在检测 WeClaw...';
    try {
      await api('/api/weclaw/health', { method: 'POST', body: '{}' });
      $('weclawStatus').textContent = 'WeClaw API 可用';
    } catch (error) {
      $('weclawStatus').textContent = error.message;
    }
  });

  $('testNotifyBtn').addEventListener('click', async () => {
    await saveConfig();
    $('weclawStatus').textContent = '正在发送测试消息...';
    try {
      await api('/api/notify/test', { method: 'POST', body: '{}' });
      $('weclawStatus').textContent = '测试消息已发送';
    } catch (error) {
      $('weclawStatus').textContent = error.message;
    }
  });
}

init().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
