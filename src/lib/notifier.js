const http = require('http');
const https = require('https');
const { formatTimestamp } = require('./time');
const {
  WeclawConversationGuard,
  appendConversationReminder,
  countPayloadMessages,
  runWeclawGuardReminderCheck
} = require('./weclawGuard');

const bindingCooldowns = new Map();

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
    dataDir: defaults.dataDir || '',
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
    logFile: weclaw.logFile || '',
    dataDir: weclaw.dataDir || ''
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
  const defaultConversationGuard = {
    enabled: true,
    maxOutboundMessages: 10,
    requiredUserMessageHours: 24,
    reminderIntervalMinutes: 30,
    reminderLeadMinutes: 60,
    requireKnownUserMessage: true,
    stateFile: ''
  };
  const merged = {
    enabled: false,
    apiUrl: 'http://127.0.0.1:18011/api/send',
    to: '',
    bindings: [],
    adminBindingName: '',
    sendImages: true,
    conversationGuard: defaultConversationGuard,
    mediaHost: '127.0.0.1',
    mediaPort: 18789,
    managedBy: '',
    command: 'weclaw',
    startArgs: ['start', '-f'],
    ...(weclaw || {})
  };
  merged.conversationGuard = {
    ...defaultConversationGuard,
    ...((weclaw && weclaw.guard) || {}),
    ...((weclaw && weclaw.conversationGuard) || {})
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

function bindingKey(binding) {
  return [binding.name || '', binding.apiUrl || '', binding.to || ''].join('|');
}

function bindingDeliveryId(binding) {
  return String(binding.name || binding.apiUrl || binding.to || bindingKey(binding)).trim();
}

function getPendingBindingIds(post) {
  if (!Array.isArray(post && post.notificationPendingBindings)) return null;
  return post.notificationPendingBindings.map((item) => String(item || '').trim()).filter(Boolean);
}

function shouldNotifyBindingForPost(post, binding) {
  const pending = getPendingBindingIds(post);
  if (!pending) return true;
  if (pending.length === 0) return false;
  return pending.includes(bindingDeliveryId(binding));
}

function parseBindingKey(key) {
  const [name = '', apiUrl = '', to = ''] = String(key || '').split('|');
  return { name, apiUrl, to };
}

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function bindingIdentityMatches(target = {}, candidate = {}) {
  const targetName = normalizeIdentity(target.name);
  const targetApiUrl = normalizeIdentity(target.apiUrl);
  const targetTo = normalizeIdentity(target.to);
  const candidateName = normalizeIdentity(candidate.name);
  const candidateApiUrl = normalizeIdentity(candidate.apiUrl);
  const candidateTo = normalizeIdentity(candidate.to);

  const nameMatch = targetName && candidateName && targetName === candidateName;
  const apiUrlMatch = targetApiUrl && candidateApiUrl && targetApiUrl === candidateApiUrl;
  const toMatch = targetTo && candidateTo && targetTo === candidateTo;

  if (targetName || targetApiUrl) return Boolean(nameMatch || apiUrlMatch);
  return Boolean(toMatch);
}

function normalizeStateResetBinding(binding, weclaw) {
  const input = binding || {};
  const normalized = normalizeBinding(input, {
    apiUrl: (weclaw && weclaw.apiUrl) || 'http://127.0.0.1:18011/api/send',
    logFile: (weclaw && weclaw.logFile) || '',
    dataDir: (weclaw && weclaw.dataDir) || ''
  });
  if (!input.name) normalized.name = '';
  if (!input.apiUrl) normalized.apiUrl = '';
  return normalized;
}

function classifyWeclawError(error) {
  const message = String((error && error.message) || error || '');
  if (/ret=-14\b|session timeout|session expired/i.test(message)) return 'session-expired';
  if (/ret=-2\b/.test(message)) return 'send-limited';
  return '';
}

function getCooldownState(binding) {
  const key = bindingKey(binding);
  const state = bindingCooldowns.get(key) || { failures: 0, until: 0, reason: '' };
  return { key, state };
}

function activeCooldown(binding, now = Date.now()) {
  const { state } = getCooldownState(binding);
  return state.until > now ? state : null;
}

function noteSendSuccess(binding) {
  bindingCooldowns.delete(bindingKey(binding));
}

function resetBindingCooldown(binding) {
  let resetCount = 0;
  for (const key of Array.from(bindingCooldowns.keys())) {
    if (key === bindingKey(binding) || bindingIdentityMatches(binding, parseBindingKey(key))) {
      bindingCooldowns.delete(key);
      resetCount += 1;
    }
  }
  return resetCount;
}

function noteSendFailure(binding, error) {
  const kind = classifyWeclawError(error);
  if (!kind) return null;

  const { key, state } = getCooldownState(binding);
  state.failures += 1;
  state.reason = kind;
  const baseMs = 30 * 60 * 1000;
  const multiplier = Math.min(6, state.failures);
  const cooldownMs = Math.min(2 * 60 * 60 * 1000, baseMs * multiplier);
  state.until = Date.now() + cooldownMs;
  bindingCooldowns.set(key, state);
  return state;
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
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
  parts.push(`时间：${formatTimestamp()}`);
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

          reject(new Error(formatHttpError(response.statusCode, responseBody)));
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

function formatHttpError(statusCode, responseBody) {
  const body = String(responseBody || '').slice(0, 300);
  const hints = [];
  if (/ret=-2\b/.test(body)) {
    hints.push('ret=-2 通常表示微信发送频率限制，先停 2-5 分钟再重试');
  }
  if (/ret=-14\b/.test(body)) {
    hints.push('ret=-14 通常表示会话或登录态过期，需要重新扫码登录');
  }
  return `HTTP ${statusCode}: ${body}${hints.length ? ` (${hints.join('；')})` : ''}`;
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
  const guard = new WeclawConversationGuard(weclaw, options);
  const failedPostIds = new Set();
  const summary = {
    sentPosts: 0,
    sentImages: 0,
    failedPosts: 0,
    failedImages: 0,
    failedPostIds: [],
    sentBindingsByPost: {},
    failedBindingsByPost: {},
    skipped: false
  };

  function addPostBinding(map, post, binding) {
    if (!post || !post.id || !binding) return;
    if (!map[post.id]) map[post.id] = [];
    const id = bindingDeliveryId(binding);
    if (id && !map[post.id].includes(id)) map[post.id].push(id);
  }

  function markSent(post, binding) {
    addPostBinding(summary.sentBindingsByPost, post, binding);
  }

  function markFailed(post, hasImage, binding) {
    summary.failedPosts += 1;
    if (hasImage) summary.failedImages += 1;
    if (post && post.id) failedPostIds.add(post.id);
    addPostBinding(summary.failedBindingsByPost, post, binding);
  }

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
        if (!shouldNotifyBindingForPost(post, binding)) continue;

        if (!binding.to) {
          log(`WeClaw notification skipped binding=${binding.name || binding.apiUrl}: to is empty`);
          markFailed(post, Boolean(mediaUrl), binding);
          continue;
        }

        const text = buildPostText(result.user || {}, post);
        const payload = {
          to: binding.to,
          text
        };
        if (weclaw.sendImages !== false && mediaUrl) {
          payload.media_url = mediaUrl;
        }

        const outboundMessages = countPayloadMessages(payload);
        const guardDecision = guard.beforeSend(binding, outboundMessages, log);
        if (!guardDecision.ok) {
          markFailed(post, Boolean(payload.media_url), binding);
          log(
            `WeClaw notification delayed post=${post.id} binding=${binding.name || binding.apiUrl}: conversationGuard=${guardDecision.reason}, detail=${guardDecision.message}`
          );
          continue;
        }
        if (guardDecision.appendReminder) {
          payload.text = appendConversationReminder(payload.text);
        }

        const cooldown = activeCooldown(binding);
        if (cooldown) {
          markFailed(post, Boolean(mediaUrl), binding);
          log(
            `WeClaw notification delayed post=${post.id} binding=${binding.name || binding.apiUrl}: cooldown=${cooldown.reason}, retryAfter=${formatDuration(cooldown.until - Date.now())}`
          );
          continue;
        }

        try {
          await sendWeclawPayload(binding, payload);
          noteSendSuccess(binding);
          guard.recordSent(binding, outboundMessages, log);
          markSent(post, binding);
          summary.sentPosts += 1;
          log(`WeClaw text sent post=${post.id} binding=${binding.name || binding.apiUrl}`);
          if (payload.media_url) {
            summary.sentImages += 1;
            log(`WeClaw image sent post=${post.id} binding=${binding.name || binding.apiUrl}`);
          }
        } catch (error) {
          markFailed(post, Boolean(payload.media_url), binding);
          const cooldownState = noteSendFailure(binding, error);
          log(`WeClaw notification failed post=${post.id} binding=${binding.name || binding.apiUrl}: ${error.message}`);
          if (cooldownState) {
            log(
              `WeClaw binding cooldown binding=${binding.name || binding.apiUrl}: reason=${cooldownState.reason}, retryAfter=${formatDuration(cooldownState.until - Date.now())}`
            );
          }
        }
      }
    }
  }

  guard.save();
  summary.failedPostIds = Array.from(failedPostIds);
  return summary;
}

async function notifyMonitorError(config, error, options = {}) {
  const log = options.log || (() => {});
  const weclaw = getWeclawConfig(config);
  const binding = getAdminBinding(weclaw);
  const guard = new WeclawConversationGuard(weclaw, options);

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

  const payload = {
    to: binding.to,
    text: buildMonitorErrorText(error, options)
  };
  const outboundMessages = countPayloadMessages(payload);
  const guardDecision = guard.beforeSend(binding, outboundMessages, log);
  if (!guardDecision.ok) {
    guard.save();
    log(
      `WeClaw admin alert delayed binding=${binding.name || binding.apiUrl}: conversationGuard=${guardDecision.reason}, detail=${guardDecision.message}`
    );
    return { ok: false, skipped: true, reason: 'conversation-required' };
  }
  if (guardDecision.appendReminder) {
    payload.text = appendConversationReminder(payload.text);
  }

  const cooldown = activeCooldown(binding);
  if (cooldown) {
    guard.save();
    log(
      `WeClaw admin alert delayed binding=${binding.name || binding.apiUrl}: cooldown=${cooldown.reason}, retryAfter=${formatDuration(cooldown.until - Date.now())}`
    );
    return { ok: false, skipped: true, reason: 'cooldown' };
  }

  try {
    await sendWeclawPayload(binding, payload);
    noteSendSuccess(binding);
    guard.recordSent(binding, outboundMessages, log);
    guard.save();
    log(`WeClaw admin alert sent binding=${binding.name || binding.apiUrl}`);
    return { ok: true, skipped: false, binding: binding.name || binding.apiUrl };
  } catch (sendError) {
    guard.save();
    const cooldownState = noteSendFailure(binding, sendError);
    log(`WeClaw admin alert failed binding=${binding.name || binding.apiUrl}: ${sendError.message}`);
    if (cooldownState) {
      log(
        `WeClaw binding cooldown binding=${binding.name || binding.apiUrl}: reason=${cooldownState.reason}, retryAfter=${formatDuration(cooldownState.until - Date.now())}`
      );
    }
    return { ok: false, skipped: false, error: sendError.message };
  }
}

async function sendWeclawTest(config, options = {}) {
  const weclaw = getWeclawConfig(config);
  const bindings = options.binding ? [normalizeBinding(options.binding)] : getActiveBindings(weclaw);
  const guard = new WeclawConversationGuard(weclaw, options);
  const log = options.log || (() => {});
  if (bindings.length === 0) throw new Error('没有启用的 WeClaw 绑定。');

  const failures = [];
  let sent = 0;
  for (const binding of bindings) {
    if (!binding.to) {
      failures.push(`${binding.name || binding.apiUrl}: 接收人 ID 为空`);
      continue;
    }
    const guardDecision = guard.beforeSend(binding, 1, log);
    if (!guardDecision.ok) {
      failures.push(
        `${binding.name || binding.apiUrl}: WeClaw conversation guard ${guardDecision.reason}: ${guardDecision.message}`
      );
      continue;
    }
    try {
      await sendWeclawPayload(binding, {
        to: binding.to,
        text: options.text || `微博监控测试消息：${formatTimestamp()}`
      });
      noteSendSuccess(binding);
      guard.recordSent(binding, 1, log);
      sent += 1;
    } catch (error) {
      failures.push(`${binding.name || binding.apiUrl}: ${error.message}`);
    }
  }

  guard.save();
  if (failures.length > 0) {
    throw new Error(`测试消息发送失败：成功 ${sent}/${bindings.length}；${failures[0]}`);
  }
  return { ok: true, sentBindings: sent };
}

function runWeclawConversationGuardReminderCheck(config, options = {}) {
  return runWeclawGuardReminderCheck(getWeclawConfig(config), options);
}

function resetWeclawBindingNotificationState(config, binding, options = {}) {
  const weclaw = getWeclawConfig(config);
  const target = normalizeStateResetBinding(binding, weclaw);
  const cooldowns = resetBindingCooldown(target);
  const guard = new WeclawConversationGuard(weclaw, options);
  const guardStates = guard.resetBinding(target);
  guard.save();
  return { ok: true, cooldowns, guardStates, binding: target.name || target.apiUrl || target.to || '' };
}

module.exports = {
  getWeclawConfig,
  normalizeBinding,
  checkWeclawBindingHealth,
  checkWeclawHealth,
  notifyMonitorError,
  notifyResults,
  resetWeclawBindingNotificationState,
  runWeclawConversationGuardReminderCheck,
  sendWeclawPayload,
  sendWeclawTest
};
