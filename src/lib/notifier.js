const http = require('http');
const https = require('https');

function getWeclawConfig(config) {
  const weclaw = config && config.notifications && config.notifications.weclaw;
  return {
    enabled: false,
    apiUrl: 'http://127.0.0.1:18011/api/send',
    to: '',
    sendImages: true,
    mediaHost: '127.0.0.1',
    mediaPort: 18789,
    managedBy: '',
    command: 'weclaw',
    startArgs: ['start', '-f'],
    ...(weclaw || {})
  };
}

function truncate(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function buildPostText(user, post) {
  const label = user.name || post.userName || user.id;
  const parts = [`【微博监控】${label} 发布新微博`];
  if (post.createdAt) parts.push(`时间：${post.createdAt}`);
  if (post.text) parts.push(`内容：${truncate(post.text, 900)}`);
  if (post.url) parts.push(`链接：${post.url}`);
  return parts.join('\n');
}

function requestJson(method, url, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = body ? JSON.stringify(body) : '';
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      target,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
        }
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          let parsed = null;
          if (responseBody) {
            try {
              parsed = JSON.parse(responseBody);
            } catch (_) {
              parsed = responseBody;
            }
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
            return;
          }

          reject(new Error(`HTTP ${response.statusCode}: ${String(responseBody).slice(0, 300)}`));
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    if (data) request.write(data);
    request.end();
  });
}

function healthUrlFromApi(apiUrl) {
  const target = new URL(apiUrl);
  return `${target.protocol}//${target.host}/health`;
}

async function checkWeclawHealth(config) {
  const weclaw = getWeclawConfig(config);
  const healthUrl = healthUrlFromApi(weclaw.apiUrl);
  await requestJson('GET', healthUrl, null, 5000);
  return { ok: true, url: healthUrl };
}

async function sendWeclawPayload(weclaw, payload) {
  return await requestJson('POST', weclaw.apiUrl, payload);
}

function buildScreenshotUrl(post, weclaw, options = {}) {
  if (!post.screenshot) return '';
  const baseUrl = options.mediaBaseUrl || weclaw.mediaBaseUrl;
  if (!baseUrl) return '';

  const url = new URL('/api/screenshot', baseUrl);
  url.searchParams.set('file', post.screenshot);
  return url.toString();
}

async function notifyResults(config, results, options = {}) {
  const log = options.log || (() => {});
  const weclaw = getWeclawConfig(config);
  const summary = { sentPosts: 0, sentImages: 0, failedPosts: 0, failedImages: 0, skipped: false };

  if (!weclaw.enabled) {
    summary.skipped = true;
    return summary;
  }
  if (!weclaw.to) {
    log('WeClaw notification skipped: notifications.weclaw.to is empty');
    summary.skipped = true;
    return summary;
  }

  for (const result of results || []) {
    const fresh = Array.isArray(result.fresh) ? result.fresh.slice().reverse() : [];
    for (const post of fresh) {
      try {
        await sendWeclawPayload(weclaw, {
          to: weclaw.to,
          text: buildPostText(result.user || {}, post)
        });
        summary.sentPosts += 1;
        log(`WeClaw text sent post=${post.id}`);
      } catch (error) {
        summary.failedPosts += 1;
        log(`WeClaw text failed post=${post.id}: ${error.message}`);
        continue;
      }

      if (weclaw.sendImages === false) continue;
      const mediaUrl = buildScreenshotUrl(post, weclaw, options);
      if (!mediaUrl) continue;

      try {
        await sendWeclawPayload(weclaw, {
          to: weclaw.to,
          media_url: mediaUrl
        });
        summary.sentImages += 1;
        log(`WeClaw image sent post=${post.id}`);
      } catch (error) {
        summary.failedImages += 1;
        log(`WeClaw image failed post=${post.id}: ${error.message}`);
      }
    }
  }

  return summary;
}

async function sendWeclawTest(config, options = {}) {
  const weclaw = getWeclawConfig(config);
  if (!weclaw.to) throw new Error('接收人 ID 为空。让接收通知的微信给机器人发一条消息后，点击“识别最近发信人”。');
  await sendWeclawPayload(weclaw, {
    to: weclaw.to,
    text: options.text || `微博监控测试消息：${new Date().toLocaleString('zh-CN', { hour12: false })}`
  });
  return { ok: true };
}

module.exports = {
  getWeclawConfig,
  checkWeclawHealth,
  notifyResults,
  sendWeclawPayload,
  sendWeclawTest
};
