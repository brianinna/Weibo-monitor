const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

function expandEnv(input) {
  if (!input) return input;
  return input
    .replace(/%([^%]+)%/g, (_, key) => process.env[key] || '')
    .replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => process.env[key] || '');
}

function isContainer() {
  return process.env.WEIBO_MONITOR_CONTAINER === '1' || fs.existsSync('/.dockerenv');
}

function removeStaleBrowserLocks(userDataDir, log) {
  if (process.platform === 'win32') return;
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const target = path.join(userDataDir, name);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true, recursive: true });
        log(`Removed stale browser lock: ${target}`);
      }
    } catch (error) {
      log(`Could not remove stale browser lock ${target}: ${error.message}`);
    }
  }
}

function uniqueArgs(args) {
  const seen = new Set();
  const unique = [];
  for (const arg of args) {
    if (!arg || seen.has(arg)) continue;
    seen.add(arg);
    unique.push(arg);
  }
  return unique;
}

function getCandidates(type) {
  if (process.platform !== 'win32') {
    const edge = [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/opt/microsoft/msedge/msedge'
    ];
    const chrome = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    ];

    if (type === 'edge') return edge;
    if (type === 'chrome') return chrome;
    return [...chrome, ...edge];
  }

  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const edge = [
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const chrome = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];

  if (type === 'edge') return edge;
  if (type === 'chrome') return chrome;
  return [...chrome, ...edge];
}

function findBrowserExecutable(type) {
  const found = getCandidates(type).find((file) => fs.existsSync(file));
  if (!found) {
    throw new Error('Edge/Chrome/Chromium was not found. Set browser.executablePath in config.json.');
  }
  return found;
}

function findBrowserExecutables(browserConfig = {}) {
  if (browserConfig.executablePath) {
    const executable = expandEnv(browserConfig.executablePath);
    if (!fs.existsSync(executable)) {
      throw new Error(`browser.executablePath does not exist: ${executable}`);
    }
    return [executable];
  }

  const type = browserConfig.type || 'auto';
  if (type !== 'auto') return [findBrowserExecutable(type)];

  const candidates = getCandidates('auto').filter((file) => fs.existsSync(file));
  if (candidates.length === 0) {
    throw new Error('Edge/Chrome/Chromium was not found. Set browser.executablePath in config.json.');
  }
  return candidates;
}

function defaultUserDataDir(executable) {
  if (process.platform !== 'win32') {
    const home = process.env.HOME || '/tmp';
    const lower = executable.toLowerCase();
    if (lower.includes('chromium')) return path.join(home, '.config', 'chromium');
    if (lower.includes('edge') || lower.includes('msedge')) return path.join(home, '.config', 'microsoft-edge');
    return path.join(home, '.config', 'google-chrome');
  }

  const local = process.env.LOCALAPPDATA || '';
  const lower = executable.toLowerCase();
  if (lower.includes('msedge.exe')) {
    return path.join(local, 'Microsoft', 'Edge', 'User Data');
  }
  return path.join(local, 'Google', 'Chrome', 'User Data');
}

function listProfiles(browserConfig = {}) {
  const scanConfig = { ...browserConfig, userDataDir: null };
  const executables = findBrowserExecutables(scanConfig);
  const seen = new Set();
  const profiles = [];

  for (const executable of executables) {
    const userDataDir = defaultUserDataDir(executable);
    const browserName = executable.toLowerCase().includes('msedge.exe') ? 'edge' : 'chrome';
    if (!fs.existsSync(userDataDir)) continue;

    for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name)) continue;

      const prefFile = path.join(userDataDir, entry.name, 'Preferences');
      let label = entry.name;
      try {
        const prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
        const localName = prefs.profile && prefs.profile.name;
        if (localName) label = `${entry.name} (${localName})`;
      } catch (_) {
        // Profile display names are best-effort.
      }

      const key = `${browserName}:${userDataDir}:${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      profiles.push({
        browser: browserName,
        executablePath: executable,
        userDataDir,
        profileDirectory: entry.name,
        label
      });
    }
  }

  return profiles;
}

function isCdpVersionPayload(payload) {
  return Boolean(payload && payload.webSocketDebuggerUrl && payload.Browser);
}

async function probeDebugPort(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!isCdpVersionPayload(payload)) {
    throw new Error(`Port ${port} is open but is not a Chrome DevTools endpoint`);
  }
  return payload;
}

async function waitForDebugPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await probeDebugPort(port);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for browser debug port ${port}: ${lastError ? lastError.message : 'unknown'}`);
}

async function connectBrowser(browserConfig = {}, log = () => {}) {
  const port = Number(browserConfig.remoteDebuggingPort || 18788);
  const startupTimeoutMs = Number(browserConfig.startupTimeoutMs || 15000);

  try {
    const version = await waitForDebugPort(port, 800);
    log(`Connected to existing browser debug port ${port}: ${version.Browser}`);
  } catch (_) {
    const executables = findBrowserExecutables(browserConfig);
    const errors = [];

    for (const executable of executables) {
      const userDataDir = expandEnv(browserConfig.userDataDir) || defaultUserDataDir(executable);
      removeStaleBrowserLocks(userDataDir, log);
      const startupUrl = browserConfig.loginUrl || 'https://passport.weibo.com/sso/signin?entry=account&source=sinassopage&url=https%3A%2F%2Fmy.sina.com.cn';
      const baseArgs = [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${userDataDir}`,
        `--profile-directory=${browserConfig.profileDirectory || 'Default'}`,
        '--no-first-run',
        '--no-default-browser-check',
      ];
      if (isContainer()) {
        baseArgs.push(
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-crash-reporter',
          '--no-zygote',
          '--window-size=1366,768'
        );
      }

      const headlessOverride = process.env.WEIBO_MONITOR_BROWSER_HEADLESS;
      if (headlessOverride === '1' || (headlessOverride !== '0' && browserConfig.headless)) {
        baseArgs.push('--headless=new');
      }
      if (Array.isArray(browserConfig.args)) baseArgs.push(...browserConfig.args);
      const args = uniqueArgs(baseArgs);
      args.push(startupUrl);

      log(`Launching browser: ${executable}`);
      log(`User data dir: ${userDataDir}`);

      const child = spawn(executable, args, {
        detached: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32' ? false : undefined
      });
      if (child.stdout) child.stdout.on('data', (chunk) => log(`[browser:out] ${String(chunk).trim()}`));
      if (child.stderr) child.stderr.on('data', (chunk) => log(`[browser:err] ${String(chunk).trim()}`));
      child.on('error', (error) => log(`Browser process error: ${error.message}`));
      child.on('exit', (code, signal) => log(`Browser process exited code=${code} signal=${signal || 'none'}`));
      if (process.platform === 'win32') child.unref();

      try {
        await waitForDebugPort(port, startupTimeoutMs);
        errors.length = 0;
        break;
      } catch (error) {
        errors.push(`${executable}: ${error.message}`);
        log('Browser debug port was not ready; trying next candidate.');
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Could not launch a browser with remote debugging.\n${errors.join('\n')}\n` +
          'If the browser is already open, close Edge/Chrome and retry, or set a separate browser.userDataDir.'
      );
    }
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();

  return {
    browser,
    context,
    async close() {
      await browser.close();
    }
  };
}

module.exports = { connectBrowser, findBrowserExecutables, listProfiles };
