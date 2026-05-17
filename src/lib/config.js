const fs = require('fs');
const path = require('path');

function getConfigPath(root) {
  return path.resolve(root, process.env.WEIBO_MONITOR_CONFIG || 'config.json');
}

function getConfigTemplatePath(root) {
  return path.resolve(root, process.env.WEIBO_MONITOR_CONFIG_TEMPLATE || 'config.example.json');
}

function ensureConfig(root) {
  const target = getConfigPath(root);
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(getConfigTemplatePath(root), target);
  return true;
}

function loadConfig(root) {
  const file = getConfigPath(root);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));

  config.browser = {
    type: 'auto',
    executablePath: null,
    remoteDebuggingPort: 18788,
    profileDirectory: 'Default',
    userDataDir: '%LOCALAPPDATA%\\WeiboMonitor\\ChromeProfile',
    loginUrl: 'https://weibo.com/',
    startupTimeoutMs: 15000,
    headless: false,
    args: [],
    ...(config.browser || {})
  };

  config.monitor = {
    checkIntervalSeconds: 300,
    notifyOnFirstRun: false,
    maxPostsPerUser: 5,
    maxScanPages: 3,
    ...(config.monitor || {})
  };

  const notificationDefaults = {
    weclaw: {
      enabled: false,
      apiUrl: 'http://127.0.0.1:18011/api/send',
      to: '',
      sendImages: true,
      mediaBaseUrl: '',
      mediaHost: '127.0.0.1',
      mediaPort: 18789,
      managedBy: '',
      command: 'weclaw',
      startArgs: ['start', '-f']
    }
  };
  config.notifications = {
    ...notificationDefaults,
    ...(config.notifications || {}),
    weclaw: {
      ...notificationDefaults.weclaw,
      ...((config.notifications && config.notifications.weclaw) || {})
    }
  };

  if (!Array.isArray(config.users) || config.users.length === 0) {
    throw new Error('config.json must contain a non-empty users array.');
  }

  return config;
}

module.exports = { ensureConfig, getConfigPath, loadConfig };
