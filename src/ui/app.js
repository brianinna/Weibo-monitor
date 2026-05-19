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

function defaultWeclawBinding(index = 0) {
  return {
    name: index === 0 ? 'weclaw' : `weclaw-${index + 1}`,
    enabled: index === 0,
    apiUrl: index === 0 ? 'http://weclaw:18011/api/send' : `http://weclaw-${index + 1}:18011/api/send`,
    to: '',
    logFile: index === 0 ? '/app/weclaw-logs/weclaw.log' : `/app/weclaw-logs/weclaw-${index + 1}.log`,
    dataDir: index === 0 ? '/app/weclaw-data/weclaw' : `/app/weclaw-data/weclaw-${index + 1}`
  };
}

function normalizeWeclawBindings(weclaw) {
  if (Array.isArray(weclaw.bindings)) {
    return weclaw.bindings.map((binding, index) => ({
      ...defaultWeclawBinding(index),
      ...binding,
      to: binding.to || ''
    }));
  }
  const legacyTo = weclaw.to || (Array.isArray(weclaw.recipients) ? weclaw.recipients[0] || '' : '');
  if (!legacyTo) return [];
  const first = defaultWeclawBinding(0);
  first.apiUrl = weclaw.apiUrl || first.apiUrl;
  first.to = legacyTo;
  return [first];
}

function getWeclawConfig() {
  if (!config.notifications) config.notifications = {};
  if (!config.notifications.weclaw) {
    config.notifications.weclaw = {
      enabled: false,
      apiUrl: 'http://127.0.0.1:18011/api/send',
      to: '',
      bindings: [],
      adminBindingName: '',
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

function collectBindingFromRow(row) {
  return {
    name: row.querySelector('[data-field="name"]').value.trim() || 'weclaw',
    enabled: row.querySelector('[data-field="enabled"]').checked,
    apiUrl: row.querySelector('[data-field="apiUrl"]').value.trim(),
    to: row.querySelector('[data-field="to"]').value.trim(),
    logFile: row.querySelector('[data-field="logFile"]').value.trim(),
    dataDir: row.querySelector('[data-field="dataDir"]').value.trim()
  };
}

function getBindingRows() {
  return Array.from(document.querySelectorAll('.weclaw-binding'));
}

function bindingName(binding, index) {
  return String((binding && binding.name) || defaultWeclawBinding(index).name).trim();
}

function showWeclawCommand(command) {
  const box = $('weclawCommandBox');
  const pre = $('weclawCommand');
  if (!box || !pre) return;
  pre.textContent = command || '';
  box.classList.toggle('hidden', !command);
}

function renderAdminBindingOptions() {
  const select = $('adminBindingName');
  if (!select) return;
  const weclaw = getWeclawConfig();
  const selected = weclaw.adminBindingName || '';
  const rows = getBindingRows();
  const bindings = rows.length > 0 ? rows.map(collectBindingFromRow) : normalizeWeclawBindings(weclaw);
  const configuredBindings = bindings
    .map((binding, index) => ({ binding, index }))
    .filter(({ binding }) => binding.enabled !== false && binding.apiUrl && binding.to);

  select.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '不发送异常告警';
  select.appendChild(empty);

  configuredBindings.forEach(({ binding, index }) => {
    const name = bindingName(binding, index);
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name} (${binding.to})`;
    select.appendChild(option);
  });

  select.value = configuredBindings.some(({ binding, index }) => bindingName(binding, index) === selected) ? selected : '';
}

function renderWeclawBindings() {
  const weclaw = getWeclawConfig();
  weclaw.bindings = normalizeWeclawBindings(weclaw);
  const list = $('weclawBindings');
  list.innerHTML = '';

  weclaw.bindings.forEach((binding, index) => {
    const row = document.createElement('div');
    row.className = 'weclaw-binding';
    row.innerHTML = `
      <label class="checkbox">
        <input data-field="enabled" type="checkbox" ${binding.enabled === false ? '' : 'checked'} />
        启用
      </label>
      <label>
        绑定名
        <input data-field="name" value="${escapeHtml(binding.name || '')}" />
      </label>
      <label>
        WeClaw API
        <input data-field="apiUrl" value="${escapeHtml(binding.apiUrl || '')}" />
      </label>
      <label>
        接收人 ID
        <input data-field="to" placeholder="user_id@im.wechat" value="${escapeHtml(binding.to || '')}" />
      </label>
      <label>
        扫码日志文件
        <input data-field="logFile" value="${escapeHtml(binding.logFile || '')}" />
      </label>
      <label>
        登录数据目录
        <input data-field="dataDir" value="${escapeHtml(binding.dataDir || '')}" />
      </label>
      <div class="binding-actions">
        <button class="secondary" type="button" data-action="qr">显示扫码日志</button>
        <button class="secondary" type="button" data-action="detect">识别最近发信人</button>
        <button class="secondary" type="button" data-action="health">检测这个绑定</button>
        <button class="secondary" type="button" data-action="test">测试这个绑定</button>
        <button class="secondary" type="button" data-action="rebind">重新绑定</button>
        <button class="secondary danger" type="button" data-action="delete">删除配置</button>
      </div>
    `;

    row.querySelectorAll('[data-field]').forEach((input) => {
      input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', renderAdminBindingOptions);
    });

    row.querySelector('[data-action="qr"]').addEventListener('click', async () => {
      const current = collectBindingFromRow(row);
      $('weclawStatus').textContent = `正在读取 ${current.name} 的扫码日志...`;
      try {
        const data = await api(`/api/weclaw/log-tail?logFile=${encodeURIComponent(current.logFile)}`);
        $('weclawQrPanel').classList.remove('hidden');
        $('weclawQrLog').textContent = data.log || '日志为空。如果这是新实例，等几秒后再刷新扫码日志。';
        if (data.qrImage) {
          $('weclawQrImage').src = data.qrImage;
          $('weclawQrImage').classList.remove('hidden');
          $('weclawQrLink').href = data.qrUrl;
          $('weclawQrLink').classList.remove('hidden');
        } else {
          $('weclawQrImage').removeAttribute('src');
          $('weclawQrImage').classList.add('hidden');
          $('weclawQrLink').classList.add('hidden');
        }
        $('weclawStatus').textContent = `已读取 ${current.name} 的扫码日志`;
      } catch (error) {
        $('weclawStatus').textContent = error.message;
      }
    });

    row.querySelector('[data-action="detect"]').addEventListener('click', async () => {
      const current = collectBindingFromRow(row);
      $('weclawStatus').textContent = `正在识别 ${current.name} 最近发信人...`;
      try {
        const data = await api(`/api/weclaw/last-sender?logFile=${encodeURIComponent(current.logFile)}`);
        row.querySelector('[data-field="to"]').value = data.to;
        renderAdminBindingOptions();
        await saveConfig(false);
        $('weclawStatus').textContent = `已填入 ${current.name} 接收人 ID：${data.to}`;
      } catch (error) {
        $('weclawStatus').textContent = error.message;
      }
    });

    row.querySelector('[data-action="health"]').addEventListener('click', async () => {
      const current = collectBindingFromRow(row);
      $('weclawStatus').textContent = `正在检测 ${current.name}...`;
      try {
        await api('/api/weclaw/health', { method: 'POST', body: JSON.stringify({ binding: current }) });
        $('weclawStatus').textContent = `${current.name} API 可用`;
      } catch (error) {
        $('weclawStatus').textContent = error.message;
      }
    });

    row.querySelector('[data-action="test"]').addEventListener('click', async () => {
      await saveConfig(false);
      const current = collectBindingFromRow(row);
      $('weclawStatus').textContent = `正在测试 ${current.name}...`;
      try {
        await api('/api/notify/test', { method: 'POST', body: JSON.stringify({ binding: current }) });
        $('weclawStatus').textContent = `${current.name} 测试消息已发送`;
      } catch (error) {
        $('weclawStatus').textContent = error.message;
      }
    });

    row.querySelector('[data-action="rebind"]').addEventListener('click', async () => {
      const current = collectBindingFromRow(row);
      const restartName = current.name || defaultWeclawBinding(index).name;
      const confirmed = window.confirm(
        `确定清空 ${restartName} 的 WeClaw 登录数据并重新绑定吗？\n\n这会保留当前配置，但不会停止正在运行的 Docker 容器。清空后需要在服务器执行：docker compose up -d --no-deps --force-recreate ${restartName}`
      );
      if (!confirmed) return;

      $('weclawStatus').textContent = `正在清空 ${restartName} 的 WeClaw 数据...`;
      try {
        await saveConfig(false);
        const data = await api('/api/weclaw/reset-binding', {
          method: 'POST',
          body: JSON.stringify({ binding: current })
        });
        const command = [
          'cd ~/Weibo-monitor',
          data.restartCommand || `docker compose up -d --no-deps --force-recreate ${restartName}`,
          `docker compose logs -f ${restartName}`
        ].join('\n');
        showWeclawCommand(command);
        $('weclawStatus').textContent = `${data.message} 复制下面命令到服务器执行。扫码后让接收通知的微信发一条消息，再点“识别最近发信人”。`;
      } catch (error) {
        $('weclawStatus').textContent = error.message;
      }
    });

    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      const current = collectBindingFromRow(row);
      const name = current.name || defaultWeclawBinding(index).name;
      const confirmed = window.confirm(
        `确定从配置中删除 ${name} 吗？\n\n这不会清空 WeClaw 登录数据，也不会删除 Docker 容器。`
      );
      if (!confirmed) return;

      weclaw.bindings.splice(index, 1);
      renderWeclawBindings();
      await saveConfig(false);
      showWeclawCommand('');
      $('weclawStatus').textContent = `已从配置中删除 ${name}。如需清空登录数据，请先使用“重新绑定”。`;
    });

    list.appendChild(row);
  });
  renderAdminBindingOptions();
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
  renderWeclawBindings();
  renderAdminBindingOptions();
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
  weclaw.bindings = getBindingRows().map(collectBindingFromRow);
  weclaw.adminBindingName = $('adminBindingName').value;
  if (!weclaw.bindings.some((binding, index) => bindingName(binding, index) === weclaw.adminBindingName)) {
    weclaw.adminBindingName = '';
  }
  const first = weclaw.bindings[0] || {};
  weclaw.apiUrl = first.apiUrl || 'http://127.0.0.1:18011/api/send';
  weclaw.to = first.to || '';
  delete weclaw.recipients;
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
  $('adminBindingName').addEventListener('change', () => {
    getWeclawConfig().adminBindingName = $('adminBindingName').value;
  });
  $('copyWeclawCommandBtn').addEventListener('click', async () => {
    const command = $('weclawCommand').textContent;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      $('weclawStatus').textContent = '重建命令已复制，可以粘贴到服务器执行';
    } catch (_) {
      $('weclawStatus').textContent = '浏览器不允许自动复制，请手动选中下面命令复制';
    }
  });

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

  $('addWeclawBindingBtn').addEventListener('click', () => {
    const weclaw = getWeclawConfig();
    weclaw.bindings = normalizeWeclawBindings(weclaw);
    weclaw.bindings.push(defaultWeclawBinding(weclaw.bindings.length));
    renderWeclawBindings();
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
