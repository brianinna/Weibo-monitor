const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { getTimeZone } = require('./time');

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    Promise.resolve(promise).catch(() => {});
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstErrorLine(error) {
  return String((error && error.message) || error || '').split(/\r?\n/)[0];
}

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
      fs.lstatSync(target);
      fs.rmSync(target, { force: true, recursive: true });
      log(`Removed stale browser lock: ${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log(`Could not remove stale browser lock ${target}: ${error.message}`);
      }
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

async function probeDebugPort(port, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!isCdpVersionPayload(payload)) {
      throw new Error(`Port ${port} is open but is not a Chrome DevTools endpoint`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDebugPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await probeDebugPort(port, Math.max(1, Math.min(1000, deadline - Date.now())));
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for browser debug port ${port}: ${lastError ? lastError.message : 'unknown'}`);
}

async function waitForDebugPortToClose(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await probeDebugPort(port, 500);
    } catch (_) {
      return true;
    }
    await sleep(300);
  }

  return false;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }
  return !isProcessAlive(pid);
}

async function terminateChild(child, log, label = 'browser') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    log(`Terminating ${label} process pid=${child.pid}`);
    child.kill('SIGTERM');
  } catch (error) {
    log(`Could not terminate ${label} process pid=${child.pid}: ${error.message}`);
    return;
  }

  const exited = await waitForChildExit(child, 3000);
  if (exited || child.exitCode !== null || child.signalCode) return;

  try {
    log(`Force killing ${label} process pid=${child.pid}`);
    child.kill('SIGKILL');
  } catch (error) {
    log(`Could not force kill ${label} process pid=${child.pid}: ${error.message}`);
  }
}

function readProcessList() {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', ['-eo', 'pid=,args='], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorOutput += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(errorOutput.trim() || `ps exited with code ${code}`));
      }
    });
  });
}

async function killBrowserProcessesByDebugPort(port, log) {
  if (process.platform === 'win32' || !isContainer()) return [];
  const marker = `--remote-debugging-port=${port}`;
  let output = '';
  try {
    output = await readProcessList();
  } catch (error) {
    log(`Could not list browser processes for debug port cleanup: ${error.message}`);
    return [];
  }

  const pids = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2] || '';
    if (!pid || pid === process.pid || !args.includes(marker)) continue;
    try {
      log(`Terminating stale browser debug-port process pid=${pid} port=${port}`);
      process.kill(pid, 'SIGTERM');
      pids.push(pid);
    } catch (error) {
      log(`Could not terminate stale browser process pid=${pid}: ${error.message}`);
    }
  }

  for (const pid of pids) {
    const exited = await waitForProcessExit(pid, 3000);
    if (exited) continue;
    try {
      log(`Force killing stale browser debug-port process pid=${pid} port=${port}`);
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      log(`Could not force kill stale browser process pid=${pid}: ${error.message}`);
    }
  }

  for (const pid of pids) {
    await waitForProcessExit(pid, 3000);
  }

  return pids;
}

function isCdpConnectFailure(error) {
  const message = String((error && error.message) || error || '');
  return /connectOverCDP|Timeout .*exceeded|WebSocket|ECONNRESET|ECONNREFUSED|socket|Target page, context or browser has been closed|Target closed|Browser has been closed|browser has disconnected/i.test(message);
}

async function launchBrowserToDebugPort(browserConfig, log, port, startupTimeoutMs, timezoneId) {
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
      env: { ...process.env, TZ: timezoneId },
      windowsHide: process.platform === 'win32' ? false : undefined
    });
    if (child.stdout) child.stdout.on('data', (chunk) => log(`[browser:out] ${String(chunk).trim()}`));
    if (child.stderr) child.stderr.on('data', (chunk) => log(`[browser:err] ${String(chunk).trim()}`));
    child.on('error', (error) => log(`Browser process error: ${error.message}`));
    child.on('exit', (code, signal) => log(`Browser process exited code=${code} signal=${signal || 'none'}`));
    if (process.platform === 'win32') child.unref();

    try {
      await waitForDebugPort(port, startupTimeoutMs);
      return child;
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
      log('Browser debug port was not ready; trying next candidate.');
      await terminateChild(child, log);
    }
  }

  throw new Error(
    `Could not launch a browser with remote debugging.\n${errors.join('\n')}\n` +
      'If the browser is already open, close Edge/Chrome and retry, or set a separate browser.userDataDir.'
  );
}

async function restartStaleBrowserDebugPort(browserConfig, log, port, launchedChild) {
  await terminateChild(launchedChild, log);
  const pids = await killBrowserProcessesByDebugPort(port, log);
  const closed = await waitForDebugPortToClose(port, 8000);
  if (!closed) {
    const detail = pids.length > 0 ? `after terminating pids=${pids.join(',')}` : 'and no matching browser process was found';
    throw new Error(`Browser debug port ${port} is still responding after stale-browser cleanup (${detail}).`);
  }
  return connectBrowser(browserConfig, log, { forceLaunch: true, allowStaleRestart: false });
}

async function applyPageTimezone(page, timezoneId, log) {
  if (!timezoneId || page.isClosed()) return;
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setTimezoneOverride', { timezoneId });
    await session.detach().catch(() => {});
  } catch (error) {
    log(`Could not set browser timezone ${timezoneId}: ${error.message}`);
  }
}

async function applyContextTimezone(context, timezoneId, log) {
  if (!timezoneId) return;
  await Promise.all(context.pages().map((page) => applyPageTimezone(page, timezoneId, log)));
  context.on('page', (page) => {
    applyPageTimezone(page, timezoneId, log);
  });
  log(`Browser timezone override: ${timezoneId}`);
}

async function connectBrowser(browserConfig = {}, log = () => {}, internal = {}) {
  const port = Number(browserConfig.remoteDebuggingPort || 18788);
  const startupTimeoutMs = Number(browserConfig.startupTimeoutMs || 15000);
  const connectTimeoutMs = Number(browserConfig.connectTimeoutMs || 30000);
  const timezoneId = browserConfig.timezoneId || getTimeZone();
  let launchedChild = null;

  if (internal.forceLaunch) {
    launchedChild = await launchBrowserToDebugPort(browserConfig, log, port, startupTimeoutMs, timezoneId);
  } else {
    try {
      const version = await waitForDebugPort(port, 800);
      log(`Connected to existing browser debug port ${port}: ${version.Browser}`);
    } catch (_) {
      launchedChild = await launchBrowserToDebugPort(browserConfig, log, port, startupTimeoutMs, timezoneId);
    }
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: connectTimeoutMs });
  } catch (error) {
    const canRestartStaleBrowser = internal.allowStaleRestart !== false && (isContainer() || launchedChild);
    if (canRestartStaleBrowser && isCdpConnectFailure(error)) {
      log(`Browser debug port ${port} did not complete CDP connect: ${firstErrorLine(error)}; restarting browser`);
      return restartStaleBrowserDebugPort(browserConfig, log, port, launchedChild);
    }
    await terminateChild(launchedChild, log);
    throw error;
  }

  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  await applyContextTimezone(context, timezoneId, log);

  return {
    browser,
    context,
    timezoneId,
    async applyPageTimezone(page) {
      await applyPageTimezone(page, timezoneId, log);
    },
    managed: Boolean(launchedChild),
    async close(options = {}) {
      const force = Boolean(options.force);
      if (force) {
        await withTimeout(browser.close(), 3000, 'browser close timed out').catch((error) => {
          log(`Browser close failed during forced reset: ${error.message}`);
        });
        await terminateChild(launchedChild, log);
        await killBrowserProcessesByDebugPort(port, log);
        return;
      }

      await browser.close();
    }
  };
}

module.exports = { connectBrowser, findBrowserExecutables, listProfiles };
