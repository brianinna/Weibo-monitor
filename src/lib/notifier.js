const http = require('http');
const https = require('https');

function splitIds(value) {
  if (Array.isArray(value)) return value.flatMap(splitIds);
  return String(value || '')
    .split(/[\s,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBinding(binding, defaults = {}, index = 0) {
  const merged = {
    name: index === 0 ? 'weclaw' : `weclaw-${index + 1}`,
    enabled: true,
    apiUrl: defaults.apiUrl || 'http://127.0.0.1:18011/api/send',
    to: '',
    logFile: defaults.logFile || '',
    ...(binding || {})
  };
  const ids = splitIds(merged.to || merged.recipient || merged.recipients);
  merged.to = ids[0] || '';
  delete merged.recipient;
  delete merged.recipients;
  return merged;
}

function getWeclawBindings(weclaw) {
  const defaults = {
    apiUrl: weclaw.apiUrl || 'http://127.0.0.1:18011/api/send',
    logFile: weclaw.logFile || ''
  };
  const configured = Array.isArray(weclaw.bindings) ? weclaw.bindings : [];
  if (configured.length > 0) {
    return configured.map((binding, index) => normalizeBinding(binding, defaults, index));
  }

  const legacyIds = splitIds(weclaw.to || weclaw.recipients);
  return [
    normalizeBinding(
      {
        name: weclaw.name || 'weclaw',
        enabled: true,
        apiUrl: defaults.apiUrl,
        to: legacyIds[0] || '',
        logFile: defaults.logFile
      },
      defaults,
      0
    )
  ];
}

function getWeclawConfig(config) {
  const weclaw = config && config.notifications && config.notifications.weclaw;
  const merged = {
    enabled: false,
    apiUrl: 'http://127.0.0.1:18011/api/send',
    to: '',
    bindings: [],
    adminBindingName: '',
    sendImages: true,
    mediaHost: '127.0.0.1',
    mediaPort: 18789,
    managedBy: '',
    command: 'weclaw',
    startArgs: ['start', '-f'],
    ...(weclaw || {})
  };
  merged.bindings = getWeclawBindings(merged);
  merged.apiUrl = merged.bindings[0] ? merged.bindings[0].apiUrl : merged.apiUrl;
  merged.to = merged.bindings[0] ? merged.bindings[0].to : '';
  delete merged.recipients;
  return merged;
}

function getActiveBindings(weclaw) {
  return weclaw.bindings.filter((binding) => binding.enabled !== false && binding.apiUrl);
}

function getAdminBinding(weclaw) {
  const adminName = String(weclaw.adminBindingName || '').trim();
  if (!adminName) return null;
  return weclaw.bindings.find((binding) => String(binding.name || '').trim() === adminName) || null;
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

function buildMonitorErrorText(error, options = {}) {
  const stack = String((error && (error.stack || error.message)) || error || '');
  const lines = stack.split(/\r?\n/).filter(Boolean);
  const message = lines[0] || 'Unknown error';
  const details = lines.slice(0, 12).join('\n');
  const parts = ['【微博监控异常】'];
  parts.push(`时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  if (options.reason) parts.push(`触发：${options.reason}`);
  parts.push(`错误：${message}`);
  if (details) parts.push(`详情：\n${truncate(details, 1600)}`);
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

async function checkWeclawBindingHealth(binding) {
  const healthUrl = healthUrlFromApi(binding.apiUrl);
  await requestJson('GET', healthUrl, null, 5000);
  return { ok: true, name: binding.name || '', url: healthUrl };
}

async function checkWeclawHealth(config) {
  const weclaw = getWeclawConfig(config);
  const bindings = getActiveBindings(weclaw);
  if (bindings.length === 0) throw new Error('没有启用的 WeClaw 绑定。');
  const results = [];
  for (const binding of bindings) {
    results.push(await checkWeclawBindingHealth(binding));
  }
  return { ok: true, results };
}

async function sendWeclawPayload(binding, payload) {
  return await requestJson('POST', binding.apiUrl, payload);
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
  const bindings = getActiveBindings(weclaw);
  const summary = { sentPosts: 0, sentImages: 0, failedPosts: 0, failedImages: 0, skipped: false };

  if (!weclaw.enabled) {
    log('WeClaw notification skipped: notifications.weclaw.enabled is false');
    summary.skipped = true;
    return summary;
  }
  if (bindings.length === 0) {
    log('WeClaw notification skipped: no enabled bindings');
    summary.skipped = true;
    return summary;
  }

  for (const result of results || []) {
    const fresh = Array.isArray(result.fresh) ? result.fresh.slice().reverse() : [];
    for (const post of fresh) {
      const mediaUrl = buildScreenshotUrl(post, weclaw, options);
      for (const binding of bindings) {
        if (!binding.to) {
          log(`WeClaw notification skipped binding=${binding.name || binding.apiUrl}: to is empty`);
          continue;
        }

        try {
          await sendWeclawPayload(binding, {
            to: binding.to,
            text: buildPostText(result.user || {}, post)
          });
          summary.sentPosts += 1;
          log(`WeClaw text sent post=${post.id} binding=${binding.name || binding.apiUrl}`);
        } catch (error) {
          summary.failedPosts += 1;
          log(`WeClaw text failed post=${post.id} binding=${binding.name || binding.apiUrl}: ${error.message}`);
          continue;
        }

        if (weclaw.sendImages === false || !mediaUrl) continue;

        try {
          await sendWeclawPayload(binding, {
            to: binding.to,
            media_url: mediaUrl
          });
          summary.sentImages += 1;
          log(`WeClaw image sent post=${post.id} binding=${binding.name || binding.apiUrl}`);
        } catch (error) {
          summary.failedImages += 1;
          log(`WeClaw image failed post=${post.id} binding=${binding.name || binding.apiUrl}: ${error.message}`);
        }
      }
    }
  }

  return summary;
}

async function notifyMonitorError(config, error, options = {}) {
  const log = options.log || (() => {});
  const weclaw = getWeclawConfig(config);
  const binding = getAdminBinding(weclaw);

  if (!binding) {
    log('WeClaw admin alert skipped: no admin binding selected');
    return { ok: false, skipped: true, reason: 'no-admin-binding' };
  }
  if (binding.enabled === false) {
    log(`WeClaw admin alert skipped binding=${binding.name || binding.apiUrl}: binding is disabled`);
    return { ok: false, skipped: true, reason: 'binding-disabled' };
  }
  if (!binding.apiUrl) {
    log(`WeClaw admin alert skipped binding=${binding.name || ''}: apiUrl is empty`);
    return { ok: false, skipped: true, reason: 'api-url-empty' };
  }
  if (!binding.to) {
    log(`WeClaw admin alert skipped binding=${binding.name || binding.apiUrl}: to is empty`);
    return { ok: false, skipped: true, reason: 'to-empty' };
  }

  try {
    await sendWeclawPayload(binding, {
      to: binding.to,
      text: buildMonitorErrorText(error, options)
    });
    log(`WeClaw admin alert sent binding=${binding.name || binding.apiUrl}`);
    return { ok: true, skipped: false, binding: binding.name || binding.apiUrl };
  } catch (sendError) {
    log(`WeClaw admin alert failed binding=${binding.name || binding.apiUrl}: ${sendError.message}`);
    return { ok: false, skipped: false, error: sendError.message };
  }
}

async function sendWeclawTest(config, options = {}) {
  const weclaw = getWeclawConfig(config);
  const bindings = options.binding ? [normalizeBinding(options.binding)] : getActiveBindings(weclaw);
  if (bindings.length === 0) throw new Error('没有启用的 WeClaw 绑定。');

  const failures = [];
  let sent = 0;
  for (const binding of bindings) {
    if (!binding.to) {
      failures.push(`${binding.name || binding.apiUrl}: 接收人 ID 为空`);
      continue;
    }
    try {
      await sendWeclawPayload(binding, {
        to: binding.to,
        text: options.text || `微博监控测试消息：${new Date().toLocaleString('zh-CN', { hour12: false })}`
      });
      sent += 1;
    } catch (error) {
      failures.push(`${binding.name || binding.apiUrl}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`测试消息发送失败：成功 ${sent}/${bindings.length}；${failures[0]}`);
  }
  return { ok: true, sentBindings: sent };
}

module.exports = {
  getWeclawConfig,
  normalizeBinding,
  checkWeclawBindingHealth,
  checkWeclawHealth,
  notifyMonitorError,
  notifyResults,
  sendWeclawPayload,
  sendWeclawTest
};
