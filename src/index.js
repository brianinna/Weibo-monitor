const fs = require('fs');
const path = require('path');
const { connectBrowser } = require('./lib/browser');
const { getConfigPath, loadConfig, ensureConfig } = require('./lib/config');
const { WeiboClient } = require('./lib/weibo');
const { StateStore } = require('./lib/state');
const { getWeclawConfig, notifyMonitorError, notifyResults } = require('./lib/notifier');
const { startScreenshotServer } = require('./lib/screenshotServer');
const { formatTimestamp } = require('./lib/time');

const ROOT = path.resolve(__dirname, '..');

function log(message) {
  console.log(`[${formatTimestamp()}] ${message}`);
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

async function startNotificationMediaServer(config) {
  const weclaw = getWeclawConfig(config);
  if (!weclaw.enabled || weclaw.sendImages === false) return null;
  const server = await startScreenshotServer(ROOT, {
    host: weclaw.mediaHost,
    port: weclaw.mediaPort
  });
  server.publicBaseUrl = weclaw.mediaBaseUrl || server.baseUrl;
  log(`通知图片服务已启动: ${server.publicBaseUrl}`);
  return server;
}

async function checkOnce(config, state, options = {}) {
  const session = await connectBrowser(config.browser, log);
  const client = new WeiboClient(session.context, { log });
  const results = [];

  try {
    for (const user of config.users) {
      const uid = String(user.id || '').trim();
      if (!uid) {
        log(`跳过缺少 id 的用户配置: ${JSON.stringify(user)}`);
        continue;
      }

      const label = user.name || uid;
      log(`检查 ${label} (${uid})`);
      const knownIds = state.getUserPostIds(uid);
      const scan = await client.fetchRecentPostsUntilKnown(uid, {
        knownIds,
        limit: config.monitor.maxPostsPerUser,
        maxPages: config.monitor.maxScanPages
      });
      const posts = scan.posts;
      const fresh = getFreshPosts(scan, posts, knownIds, config.monitor.notifyOnFirstRun);

      const screenshotDir = path.join(ROOT, 'data', 'screenshots', uid);
      await client.capturePostScreenshots(
        uid,
        uniquePosts([...posts.slice(0, config.monitor.maxPostsPerUser), ...fresh]),
        screenshotDir
      );
      state.upsertPosts(uid, scan.scannedPosts || posts);

      if (knownIds.size === 0 && !config.monitor.notifyOnFirstRun) {
        log(`${label}: 首次运行，已记录 ${posts.length} 条微博，不推送历史内容`);
      } else if (fresh.length === 0) {
        log(`${label}: 无新微博`);
      } else {
        for (const post of fresh.slice().reverse()) {
          log(`发现新微博 ${label}: ${post.url}`);
          log(`内容: ${post.text}`);
        }
      }

      results.push({
        user: { ...user, id: uid },
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
  } finally {
    await state.save();
    await session.close();
  }

  const notificationSummary = await notifyResults(config, results, {
    log,
    mediaBaseUrl: options.mediaBaseUrl
  });
  if (!notificationSummary.skipped) {
    log(
      `通知完成: posts=${notificationSummary.sentPosts}, images=${notificationSummary.sentImages}, failedPosts=${notificationSummary.failedPosts}, failedImages=${notificationSummary.failedImages}`
    );
  }

  return results;
}

async function monitorLoop() {
  const config = loadConfig(ROOT);
  const state = new StateStore(path.join(ROOT, 'data', 'state.json'));
  await state.load();
  const mediaServer = await startNotificationMediaServer(config).catch((error) => {
    log(`通知图片服务启动失败: ${error.message}`);
    return null;
  });

  const intervalMs = Math.max(30, Number(config.monitor.checkIntervalSeconds || 300)) * 1000;
  log(`开始监控，间隔 ${Math.round(intervalMs / 1000)} 秒`);

  while (true) {
    try {
      await checkOnce(config, state, { mediaBaseUrl: mediaServer && mediaServer.publicBaseUrl });
    } catch (error) {
      log(`检查失败: ${error.stack || error.message}`);
      await notifyMonitorError(config, error, { log, reason: 'interval' });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const command = process.argv[2] || 'monitor';

  if (command === 'init') {
    const created = ensureConfig(ROOT);
    console.log(created ? '已生成 config.json' : 'config.json 已存在');
    return;
  }

  if (!fs.existsSync(getConfigPath(ROOT))) {
    ensureConfig(ROOT);
    console.log('已生成 config.json，请先修改 users 后再运行。');
    return;
  }

  if (command === 'check') {
    const config = loadConfig(ROOT);
    const state = new StateStore(path.join(ROOT, 'data', 'state.json'));
    await state.load();
    const mediaServer = await startNotificationMediaServer(config).catch((error) => {
      log(`通知图片服务启动失败: ${error.message}`);
      return null;
    });
    try {
      await checkOnce(config, state, { mediaBaseUrl: mediaServer && mediaServer.publicBaseUrl });
    } finally {
      if (mediaServer) {
        await new Promise((resolve) => mediaServer.server.close(resolve));
      }
    }
    return;
  }

  if (command === 'monitor') {
    await monitorLoop();
    return;
  }

  console.error(`未知命令: ${command}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
