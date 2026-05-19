const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { getConfigPath, loadConfig, ensureConfig } = require('./lib/config');
const { listProfiles, connectBrowser } = require('./lib/browser');
const { WeiboClient, isRecoverablePageError } = require('./lib/weibo');
const { parseWeiboUser } = require('./lib/user');
const { StateStore } = require('./lib/state');
const { PagePool } = require('./lib/pagePool');
const { serveScreenshot } = require('./lib/screenshotServer');
const { checkWeclawBindingHealth, checkWeclawHealth, getWeclawConfig, normalizeBinding, notifyMonitorError, notifyResults, sendWeclawTest } = require('./lib/notifier');

const ROOT = path.resolve(__dirname, '..');
const UI_ROOT = path.join(ROOT, 'src', 'ui');
const HOST = process.env.WEIBO_MONITOR_UI_HOST || '127.0.0.1';
const PORT = Number(process.env.WEIBO_MONITOR_UI_PORT || 18787);
const OPEN_BROWSER_ON_START = process.env.WEIBO_MONITOR_OPEN_BROWSER_ON_START !== '0';
const WECLAW_LOG_FILE = process.env.WEIBO_MONITOR_WECLAW_LOG || path.join(ROOT, 'data', 'weclaw.log');
const WECLAW_LOG_DIR = process.env.WEIBO_MONITOR_WECLAW_LOG_DIR || path.dirname(WECLAW_LOG_FILE);
const WECLAW_DATA_DIR = process.env.WEIBO_MONITOR_WECLAW_DATA_DIR || path.join(ROOT, 'data', 'weclaw-data');
let browserSession = null;
let pagePool = null;
let loginPage = null;
let monitorTimer = null;
let monitorRunning = false;
let weclawProcess = null;
const runtimeLogs = [];

function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  runtimeLogs.push(line);
  if (runtimeLogs.length > 300) runtimeLogs.shift();
  console.log(line);
}

function firstErrorLine(error) {
  return String((error && error.message) || error || '').split(/\r?\n/)[0];
}

async function resetBrowserSession(reason) {
  const session = browserSession;
  browserSession = null;
  pagePool = null;
  loginPage = null;
  if (reason) addLog(`browser session reset: ${reason}`);
  if (session && session.browser) {
    try {
      if (typeof session.browser.disconnect === 'function') {
        session.browser.disconnect();
      } else {
        await session.browser.close();
      }
    } catch (error) {
      addLog(`browser session reset cleanup failed: ${error.message}`);
    }
  }
}

async function getBrowserSession(config) {
  if (browserSession) {
    try {
      if (browserSession.browser.isConnected()) return browserSession;
    } catch (_) {
    }
    await resetBrowserSession('browser disconnected');
  }

  browserSession = await connectBrowser(config.browser, (message) => console.log(message));
  pagePool = new PagePool(browserSession.context, { log: addLog });
  return browserSession;
}

async function getWeiboClient(config) {
  const session = await getBrowserSession(config);
  return new WeiboClient(session.context, { pagePool, log: addLog });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function readConfig() {
  ensureConfig(ROOT);
  return loadConfig(ROOT);
}

function writeConfig(config) {
  const file = getConfigPath(ROOT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}

function readFileTail(file, maxBytes = 256 * 1024) {
  if (!fs.existsSync(file)) return '';
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function extractLatestQrUrl(text) {
  let latest = '';
  const pattern = /QR URL:\s*(https?:\/\/\S+)/g;
  for (const match of String(text || '').matchAll(pattern)) {
    latest = match[1];
  }
  return latest;
}

function compactWeclawLog(text) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const compact = [];
  let skippingTerminalQr = false;
  for (const line of lines) {
    if (/Scan this QR code with WeChat:/i.test(line)) {
      compact.push(line);
      skippingTerminalQr = true;
      continue;
    }
    if (/QR URL:/i.test(line)) {
      compact.push(line);
      skippingTerminalQr = false;
      continue;
    }
    if (skippingTerminalQr) continue;
    compact.push(line);
  }
  return compact.join('\n').trim();
}

function resolveWeclawLogFile(input) {
  const logDir = path.resolve(WECLAW_LOG_DIR);
  const requested = input ? String(input) : WECLAW_LOG_FILE;
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(logDir, requested);
  if (resolved !== logDir && !resolved.startsWith(`${logDir}${path.sep}`)) {
    throw new Error('Invalid WeClaw log file path.');
  }
  return resolved;
}

function resolveWeclawDataDir(input, name) {
  const dataRoot = path.resolve(WECLAW_DATA_DIR);
  const fallbackName = String(name || 'weclaw').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const requested = input ? String(input) : fallbackName;
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(dataRoot, requested);
  if (resolved === dataRoot || !resolved.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error('Invalid WeClaw data directory path.');
  }
  return resolved;
}

function clearDirectoryContents(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function clearWeclawBindingData(binding) {
  const normalized = normalizeBinding(binding || {});
  const safeName = String(normalized.name || 'weclaw').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dataDir = resolveWeclawDataDir(normalized.dataDir || safeName, safeName);
  const logFile = resolveWeclawLogFile(normalized.logFile || `${safeName}.log`);
  const containerName = normalized.name || safeName || 'weclaw';
  clearDirectoryContents(dataDir);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '', 'utf8');
  return {
    ok: true,
    name: normalized.name,
    dataDir,
    logFile,
    restartCommand: `docker compose up -d --no-deps --force-recreate ${containerName}`,
    message: `已清空 ${normalized.name || 'WeClaw'} 的登录数据和日志。正在运行的 WeClaw 容器不会自动失效，必须重建对应容器后才会重新出扫码。`
  };
}

function extractLatestWeclawSender(text) {
  let latest = null;
  const pattern = /\[handler\]\s+received from\s+([^:\s]+@im\.wechat):/g;
  for (const match of String(text || '').matchAll(pattern)) {
    latest = match[1];
  }
  return latest;
}

function findLatestWeclawSender(logFile) {
  const resolvedLogFile = resolveWeclawLogFile(logFile);
  const fromFile = extractLatestWeclawSender(readFileTail(resolvedLogFile));
  if (fromFile) return { to: fromFile, source: resolvedLogFile };

  const fromRuntime = logFile ? null : extractLatestWeclawSender(runtimeLogs.join('\n'));
  if (fromRuntime) return { to: fromRuntime, source: 'runtime logs' };

  return null;
}

async function readWeclawLogTail(logFile) {
  const resolvedLogFile = resolveWeclawLogFile(logFile);
  const rawLog = readFileTail(resolvedLogFile, 32 * 1024);
  const qrUrl = extractLatestQrUrl(rawLog);
  return {
    logFile: resolvedLogFile,
    log: compactWeclawLog(rawLog),
    qrUrl,
    qrImage: qrUrl
      ? await QRCode.toDataURL(qrUrl, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320
        })
      : ''
  };
}

function loginScreenshotPath() {
  return path.join(ROOT, 'data', 'login-screenshot.png');
}

function defaultWeiboLoginUrl() {
  return 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&disp=popup&url=https%3A%2F%2Fweibo.com%2F';
}

async function getLoginPage(config) {
  const session = await getBrowserSession(config);
  if (loginPage && !loginPage.isClosed()) return loginPage;
  const existing = session.context.pages().find((page) => !page.isClosed());
  loginPage = existing || await session.context.newPage();
  return loginPage;
}

async function waitForReadyScreenshot(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1800);
}

async function findLoginPopup(context, page) {
  const popupPromise = page.waitForEvent('popup', { timeout: 6000 }).catch(() => null);
  const loginButton = page
    .locator('text=登录')
    .filter({ hasNotText: '登录/注册' })
    .first();

  try {
    if ((await loginButton.count()) > 0) {
      await loginButton.click({ timeout: 5000 });
    }
  } catch (_) {
    // Some Weibo pages open the login layer from scripts that are brittle in headless mode.
  }

  const popup = await popupPromise;
  if (popup) return popup;

  const pages = context.pages().filter((item) => !item.isClosed());
  const passport = pages.find((item) => /passport\.weibo\.com|newlogin/i.test(item.url()));
  return passport || page;
}

async function openLoginAndCapture(config) {
  const page = await getLoginPage(config);
  const context = page.context();
  await page.setViewportSize({ width: 1280, height: 900 });
  const configuredUrl = config.browser.loginUrl || '';
  const loginUrl = configuredUrl === 'https://weibo.com/' ? defaultWeiboLoginUrl() : configuredUrl || defaultWeiboLoginUrl();
  await page.goto(loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await waitForReadyScreenshot(page);

  const capturePage = /passport\.weibo\.com/i.test(page.url()) ? page : await findLoginPopup(context, page);
  loginPage = capturePage;
  await capturePage.setViewportSize({ width: 1000, height: 760 }).catch(() => {});
  await waitForReadyScreenshot(capturePage);

  const file = loginScreenshotPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await capturePage.screenshot({ path: file, fullPage: false, timeout: 12000 });
  return {
    url: capturePage.url(),
    screenshotUrl: `/api/browser/login-screenshot?t=${Date.now()}`
  };
}

function uniquePosts(posts) {
  const seen = new Set();
  const unique = [];
  for (const post of posts) {
    if (!post || seen.has(post.id)) continue;
    seen.add(post.id);
    unique.push(post);
  }
  return unique;
}

function getFreshPosts(scan, posts, knownIds, notifyOnFirstRun) {
  if (knownIds.size === 0 && !notifyOnFirstRun) return [];
  if (Array.isArray(scan.newPosts)) return scan.newPosts;
  return (scan.scannedPosts || posts).filter((post) => !knownIds.has(post.id));
}

function getMediaBaseUrl(config) {
  const weclaw = getWeclawConfig(config);
  if (weclaw.mediaBaseUrl) return weclaw.mediaBaseUrl;
  const host = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  return `http://${host}:${PORT}`;
}

function startWeclaw(config) {
  if (weclawProcess && !weclawProcess.killed) {
    return { ok: true, started: false, message: 'WeClaw is already starting or running from this UI process.' };
  }

  const weclaw = getWeclawConfig(config);
  if (weclaw.managedBy === 'external') {
    return { ok: true, started: false, message: 'WeClaw is managed externally. Use docker compose logs -f weclaw to scan the QR code.' };
  }

  const args = Array.isArray(weclaw.startArgs) && weclaw.startArgs.length > 0 ? weclaw.startArgs : ['start', '-f'];
  weclawProcess = spawn(weclaw.command || 'weclaw', args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const pipeLog = (streamName, chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) addLog(`[weclaw:${streamName}] ${line}`);
    }
  };

  weclawProcess.stdout.on('data', (chunk) => pipeLog('out', chunk));
  weclawProcess.stderr.on('data', (chunk) => pipeLog('err', chunk));
  weclawProcess.on('error', (error) => {
    addLog(`WeClaw start failed: ${error.message}`);
    weclawProcess = null;
  });
  weclawProcess.on('exit', (code, signal) => {
    addLog(`WeClaw exited code=${code} signal=${signal || 'none'}`);
    weclawProcess = null;
  });

  addLog(`WeClaw start command: ${weclaw.command || 'weclaw'} ${args.join(' ')}`);
  return { ok: true, started: true };
}

async function checkLogin(config) {
  const client = await getWeiboClient(config);
  const loggedIn = await client.hasLoginCookies();
  return { loggedIn };
}

async function checkOnce(config) {
  const state = new StateStore(path.join(ROOT, 'data', 'state.json'));
  await state.load();
  const client = await getWeiboClient(config);
  const results = [];

  for (const user of config.users) {
    const knownIds = state.getUserPostIds(user.id);
    const scan = await client.fetchRecentPostsUntilKnown(user.id, {
      knownIds,
      limit: config.monitor.maxPostsPerUser,
      maxPages: config.monitor.maxScanPages
    });
    const posts = scan.posts;
    const fresh = getFreshPosts(scan, posts, knownIds, config.monitor.notifyOnFirstRun);

    const screenshotDir = path.join(ROOT, 'data', 'screenshots', user.id);
    await client.capturePostScreenshots(
      user.id,
      uniquePosts([...posts.slice(0, config.monitor.maxPostsPerUser), ...fresh]),
      screenshotDir
    );
    state.upsertPosts(user.id, scan.scannedPosts || posts);
    addLog(
      `uid=${user.id} posts=${posts.length}, fresh=${fresh.length}, knownBefore=${knownIds.size}, hitKnown=${scan.hitKnown}, pages=${scan.pages}, latest=${posts[0] ? posts[0].id : 'none'}`
    );
    results.push({
      user,
      count: posts.length,
      freshCount: fresh.length,
      latest: posts[0] || null,
      posts: posts.slice(0, config.monitor.maxPostsPerUser),
      fresh,
      scan: {
        pages: scan.pages,
        hitKnown: scan.hitKnown,
        source: scan.source,
        total: scan.total
      }
    });
  }
  await state.save();
  const notificationSummary = await notifyResults(config, results, {
    log: addLog,
    mediaBaseUrl: getMediaBaseUrl(config)
  });
  if (!notificationSummary.skipped) {
    addLog(
      `notification done posts=${notificationSummary.sentPosts}, images=${notificationSummary.sentImages}, failedPosts=${notificationSummary.failedPosts}, failedImages=${notificationSummary.failedImages}`
    );
  }
  return results;
}

async function runScheduledCheck(reason) {
  if (monitorRunning) {
    addLog(`monitor skipped reason=${reason}, previous check is still running`);
    return;
  }
  monitorRunning = true;
  let config;
  try {
    addLog(`monitor start reason=${reason}`);
    config = readConfig();
    const results = await checkOnce(config);
    const freshTotal = results.reduce((sum, item) => sum + item.freshCount, 0);
    addLog(`monitor done reason=${reason}, users=${results.length}, fresh=${freshTotal}`);
  } catch (error) {
    addLog(`monitor failed reason=${reason}: ${error.stack || error.message}`);
    try {
      await notifyMonitorError(config || readConfig(), error, { log: addLog, reason });
    } catch (alertError) {
      addLog(`monitor alert failed reason=${reason}: ${alertError.message}`);
    }
    if (isRecoverablePageError(error)) {
      await resetBrowserSession(`recoverable monitor failure: ${firstErrorLine(error)}`);
    }
  } finally {
    monitorRunning = false;
  }
}

function startMonitorScheduler() {
  if (monitorTimer) clearInterval(monitorTimer);
  const config = readConfig();
  const intervalSeconds = Math.max(30, Number(config.monitor.checkIntervalSeconds || 300));
  addLog(`monitor scheduler started interval=${intervalSeconds}s`);
  monitorTimer = setInterval(() => {
    runScheduledCheck('interval');
  }, intervalSeconds * 1000);
  runScheduledCheck('startup');
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const target = path.normalize(path.join(UI_ROOT, file));

  if (!target.startsWith(UI_ROOT) || !fs.existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript'
  };
  res.writeHead(200, { 'content-type': `${types[path.extname(target)] || 'text/plain'}; charset=utf-8` });
  res.end(fs.readFileSync(target));
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, readConfig());
  }

  if (req.method === 'GET' && url.pathname === '/api/profiles') {
    const config = readConfig();
    return sendJson(res, 200, { profiles: listProfiles(config.browser) });
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    return sendJson(res, 200, { logs: runtimeLogs });
  }

  if (req.method === 'GET' && url.pathname === '/api/posts') {
    const uid = url.searchParams.get('uid');
    if (!uid) return sendJson(res, 400, { error: 'uid is required' });
    const state = new StateStore(path.join(ROOT, 'data', 'state.json'));
    await state.load();
    const user = state.state.users[uid] || { posts: [] };
    return sendJson(res, 200, { uid, posts: user.posts || [] });
  }

  if (req.method === 'GET' && url.pathname === '/api/screenshot') {
    serveScreenshot(ROOT, req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/browser/login-screenshot') {
    const file = loginScreenshotPath();
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = await readBody(req);
    const config = readConfig();
    const existingNotifications = config.notifications;
    config.browser = { ...config.browser, ...(body.browser || {}) };
    config.monitor = { ...config.monitor, ...(body.monitor || {}) };
    config.notifications = { ...existingNotifications, ...(body.notifications || {}) };
    if (body.notifications && body.notifications.weclaw) {
      config.notifications.weclaw = { ...existingNotifications.weclaw, ...body.notifications.weclaw };
    }
    config.users = Array.isArray(body.users) ? body.users : config.users;
    writeConfig(config);
    startMonitorScheduler();
    return sendJson(res, 200, { ok: true, config });
  }

  if (req.method === 'POST' && url.pathname === '/api/weclaw/start') {
    try {
      return sendJson(res, 200, startWeclaw(readConfig()));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/weclaw/health') {
    try {
      const body = await readBody(req);
      if (body.binding) return sendJson(res, 200, await checkWeclawBindingHealth(normalizeBinding(body.binding)));
      return sendJson(res, 200, await checkWeclawHealth(readConfig()));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/weclaw/last-sender') {
    try {
      const sender = findLatestWeclawSender(url.searchParams.get('logFile'));
      if (!sender) {
        return sendJson(res, 404, {
          error: '没有在这个 WeClaw 日志里找到最近发信人。先扫码登录，再让接收通知的微信给对应机器人发一条消息。',
          logFile: resolveWeclawLogFile(url.searchParams.get('logFile'))
        });
      }
      return sendJson(res, 200, sender);
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/weclaw/log-tail') {
    try {
      return sendJson(res, 200, await readWeclawLogTail(url.searchParams.get('logFile')));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/weclaw/delete-binding') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, clearWeclawBindingData(body.binding));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/test') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await sendWeclawTest(readConfig(), body || {}));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/users/parse') {
    const body = await readBody(req);
    const parsed = parseWeiboUser(body.input);
    return sendJson(res, parsed ? 200 : 400, parsed || { error: 'Cannot parse Weibo UID or profile URL.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/login/check') {
    try {
      return sendJson(res, 200, await checkLogin(readConfig()));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/browser/open') {
    try {
      const config = readConfig();
      return sendJson(res, 200, { ok: true, ...(await openLoginAndCapture(config)) });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/check') {
    let config;
    try {
      config = readConfig();
      return sendJson(res, 200, { results: await checkOnce(config) });
    } catch (error) {
      try {
        await notifyMonitorError(config || readConfig(), error, { log: addLog, reason: 'manual' });
      } catch (alertError) {
        addLog(`manual check alert failed: ${alertError.message}`);
      }
      if (isRecoverablePageError(error)) {
        await resetBrowserSession(`recoverable manual check failure: ${firstErrorLine(error)}`);
      }
      return sendJson(res, 500, { error: error.message });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const url = `http://${displayHost}:${PORT}`;
  console.log(`Weibo Monitor UI: ${url}`);
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }

  if (OPEN_BROWSER_ON_START) {
    getBrowserSession(readConfig())
      .then(async (session) => {
        const config = readConfig();
        const firstUser = config.users && config.users[0];
        const targetUrl = firstUser && firstUser.id ? `https://weibo.com/${firstUser.id}` : config.browser.loginUrl;
        const page = firstUser && firstUser.id ? await pagePool.getUserPage(firstUser.id) : await session.context.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('Controlled browser is ready.');
      })
      .catch((error) => {
        console.error(`Could not prepare controlled browser: ${error.message}`);
      });
  }

  startMonitorScheduler();
});
