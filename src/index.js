const fs = require('fs');
const path = require('path');
const { connectBrowser } = require('./lib/browser');
const { getConfigPath, loadConfig, ensureConfig } = require('./lib/config');
const { WeiboClient, isRecoverablePageError } = require('./lib/weibo');
const { StateStore } = require('./lib/state');
const {
  getWeclawConfig,
  notifyMonitorError,
  notifyResults,
  runWeclawConversationGuardReminderCheck
} = require('./lib/notifier');
const { startScreenshotServer } = require('./lib/screenshotServer');
const { formatTimestamp } = require('./lib/time');

const ROOT = path.resolve(__dirname, '..');

function log(message) {
  console.log(`[${formatTimestamp()}] ${message}`);
}

function firstErrorLine(error) {
  return String((error && error.message) || error || '').split(/\r?\n/)[0];
}

function weclawNotifyOptions(extra = {}) {
  return {
    root: ROOT,
    log,
    ...extra
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
  const stateUpdates = [];
  const screenshotFailures = [];
  let checkError = null;

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
      const screenshotTargets = uniquePosts([...posts.slice(0, config.monitor.maxPostsPerUser), ...fresh]);
      await client.capturePostScreenshots(uid, screenshotTargets, screenshotDir);
      for (const post of screenshotTargets) {
        if (post.screenshotError) {
          screenshotFailures.push({ uid, postId: post.id, error: post.screenshotError });
        }
      }
      stateUpdates.push({
        uid,
        posts: scan.scannedPosts || posts,
        freshIds: new Set(fresh.map((post) => post.id))
      });

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
  } catch (error) {
    checkError = error;
    throw error;
  } finally {
    await session.close({ force: checkError && isRecoverablePageError(checkError) });
  }

  const notificationSummary = await notifyResults(config, results, {
    ...weclawNotifyOptions(),
    mediaBaseUrl: options.mediaBaseUrl
  });
  if (!notificationSummary.skipped) {
    log(
      `通知完成: posts=${notificationSummary.sentPosts}, images=${notificationSummary.sentImages}, failedPosts=${notificationSummary.failedPosts}, failedImages=${notificationSummary.failedImages}`
    );
  }

  const failedPostIds = new Set(notificationSummary.failedPostIds || []);
  for (const update of stateUpdates) {
    const hasFailedFresh = Array.from(update.freshIds).some((id) => failedPostIds.has(id));
    const postsToPersist = hasFailedFresh
      ? update.posts.filter((post) => !update.freshIds.has(post.id))
      : update.posts;

    if (hasFailedFresh) {
      log(`uid=${update.uid} pending notification retry posts=${Array.from(update.freshIds).join(', ')}`);
    }

    state.upsertPosts(update.uid, postsToPersist);
  }
  await state.save();

  const warningLines = [];
  if (screenshotFailures.length > 0) {
    warningLines.push(`Screenshot failures=${screenshotFailures.length}`);
    warningLines.push(
      screenshotFailures
        .slice(0, 8)
        .map((item) => `${item.uid}/${item.postId}: ${firstErrorLine(item.error)}`)
        .join('\n')
    );
  }
  if (notificationSummary.failedPosts > 0) {
    warningLines.push(
      `Notification failures posts=${notificationSummary.failedPosts}, images=${notificationSummary.failedImages}, retryPostIds=${(notificationSummary.failedPostIds || []).join(', ')}`
    );
  }
  if (warningLines.length > 0) {
    await notifyMonitorError(config, new Error(warningLines.filter(Boolean).join('\n')), weclawNotifyOptions({ reason: 'degraded' }));
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

  const guardReminderTimer = setInterval(() => {
    try {
      runWeclawConversationGuardReminderCheck(config, weclawNotifyOptions());
    } catch (error) {
      log(`WeClaw conversation guard reminder check failed: ${error.message}`);
    }
  }, 60 * 1000);
  if (typeof guardReminderTimer.unref === 'function') guardReminderTimer.unref();
  runWeclawConversationGuardReminderCheck(config, weclawNotifyOptions());

  while (true) {
    try {
      await checkOnce(config, state, { mediaBaseUrl: mediaServer && mediaServer.publicBaseUrl });
    } catch (error) {
      log(`检查失败: ${error.stack || error.message}`);
      await notifyMonitorError(config, error, weclawNotifyOptions({ reason: 'interval' }));
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
