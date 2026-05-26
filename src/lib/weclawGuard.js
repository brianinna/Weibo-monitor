const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_OUTBOUND_MESSAGES = 10;
const DEFAULT_REQUIRED_USER_MESSAGE_HOURS = 24;
const DEFAULT_REMINDER_INTERVAL_MINUTES = 30;
const DEFAULT_REMINDER_LEAD_MINUTES = 60;
const DEFAULT_LOG_TAIL_BYTES = 1024 * 1024;

const USER_MESSAGE_REMINDER_TEXT =
  'WeClaw\u63d0\u9192\uff1a\u672c\u6761\u540e\u5c06\u6682\u505c\u901a\u77e5\u3002\u8bf7\u7528\u63a5\u6536\u5fae\u4fe1\u4e3b\u52a8\u7ed9\u673a\u5668\u4eba\u53d1\u9001\u4efb\u610f\u4e00\u53e5\u8bdd\uff0c\u7a0b\u5e8f\u8bc6\u522b\u5230\u6765\u4fe1\u540e\u4f1a\u7ee7\u7eed\u53d1\u9001\u3002';

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeConversationGuardConfig(weclaw = {}) {
  const raw = weclaw.conversationGuard || weclaw.guard || {};
  const enabled = raw.enabled !== false;
  return {
    enabled,
    maxOutboundMessages: Math.max(1, Math.floor(toPositiveNumber(raw.maxOutboundMessages, DEFAULT_MAX_OUTBOUND_MESSAGES))),
    requiredUserMessageHours: toPositiveNumber(raw.requiredUserMessageHours, DEFAULT_REQUIRED_USER_MESSAGE_HOURS),
    reminderIntervalMinutes: toPositiveNumber(raw.reminderIntervalMinutes, DEFAULT_REMINDER_INTERVAL_MINUTES),
    reminderLeadMinutes: toPositiveNumber(raw.reminderLeadMinutes, DEFAULT_REMINDER_LEAD_MINUTES),
    requireKnownUserMessage: raw.requireKnownUserMessage !== false,
    stateFile: raw.stateFile || weclaw.guardStateFile || ''
  };
}

function bindingKey(binding) {
  return [binding.name || '', binding.apiUrl || '', binding.to || ''].join('|');
}

function parseBindingKey(key) {
  const [name = '', apiUrl = '', to = ''] = String(key || '').split('|');
  return { name, apiUrl, to };
}

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function bindingMatches(target = {}, candidate = {}) {
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

function bindingLabel(binding) {
  return binding.name || binding.to || binding.apiUrl || 'weclaw';
}

function countPayloadMessages(payload) {
  if (!payload) return 1;
  return 1 + (payload.media_url ? 1 : 0);
}

function appendConversationReminder(text) {
  const value = String(text || '');
  if (value.includes(USER_MESSAGE_REMINDER_TEXT)) return value;
  return `${value}\n\n${USER_MESSAGE_REMINDER_TEXT}`;
}

function isoTime(ms) {
  return new Date(ms).toISOString();
}

function formatLocalTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

function resolveStateFile(config, options = {}) {
  const requested = config.stateFile || '';
  if (requested) {
    return path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(options.root || process.cwd(), requested);
  }
  return path.resolve(options.root || process.cwd(), 'data', 'weclaw-guard-state.json');
}

function resolveLogFile(binding, weclaw = {}, options = {}) {
  const requested = binding.logFile || weclaw.logFile || process.env.WEIBO_MONITOR_WECLAW_LOG || '';
  if (requested) {
    const baseDir =
      options.weclawLogDir ||
      process.env.WEIBO_MONITOR_WECLAW_LOG_DIR ||
      (options.root ? path.join(options.root, 'data') : process.cwd());
    return path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(baseDir, requested);
  }
  return options.root ? path.join(options.root, 'data', 'weclaw.log') : '';
}

function readTextTail(file, maxBytes = DEFAULT_LOG_TAIL_BYTES) {
  if (!file || !fs.existsSync(file)) return '';
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function parseLineTimestamp(line) {
  const match = String(line || '').match(/(?:^|\[|\s)(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  const value = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || 0)
  ).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function normalizeSender(value) {
  return String(value || '').trim().toLowerCase();
}

function lineFingerprint(source, line) {
  const text = String(line || '');
  const inbound = text.match(/\[handler\]\s+received from\s+([^:\s]+@im\.wechat):.*$/i);
  return (inbound ? inbound[0] : text).slice(-500);
}

function findLatestInboundInText(text, binding, source) {
  const expectedSender = normalizeSender(binding.to);
  if (!expectedSender) return null;

  let latest = null;
  const lines = String(text || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/\[handler\]\s+received from\s+([^:\s]+@im\.wechat):/i);
    if (!match || normalizeSender(match[1]) !== expectedSender) continue;

    const timestamp = parseLineTimestamp(line);
    latest = {
      sender: match[1],
      timestamp,
      fingerprint: `${timestamp || `${source}:${index}`}:${lineFingerprint(source, line)}`,
      source,
      index
    };
  }
  return latest;
}

function findLatestInbound(binding, weclaw, options = {}) {
  const candidates = [];
  const logFile = resolveLogFile(binding, weclaw, options);
  const fromFile = findLatestInboundInText(readTextTail(logFile), binding, logFile || 'weclaw-log');
  if (fromFile) candidates.push(fromFile);

  const runtimeText = options.weclawRuntimeLogText || options.runtimeLogText || '';
  const fromRuntime = findLatestInboundInText(runtimeText, binding, 'runtime-log');
  if (fromRuntime) candidates.push(fromRuntime);

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const leftTime = left.timestamp || 0;
    const rightTime = right.timestamp || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.index - right.index;
  });
  return candidates[candidates.length - 1];
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed.bindings) parsed.bindings = {};
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { bindings: {} };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

class WeclawConversationGuard {
  constructor(weclaw = {}, options = {}) {
    this.weclaw = weclaw || {};
    this.options = options || {};
    this.config = normalizeConversationGuardConfig(this.weclaw);
    this.stateFile = resolveStateFile(this.config, this.options);
    this.state = { bindings: {} };
    this.loaded = false;
    this.dirty = false;
  }

  load() {
    if (this.loaded) return;
    this.state = loadState(this.stateFile);
    this.loaded = true;
  }

  save() {
    if (!this.loaded || !this.dirty) return;
    saveState(this.stateFile, this.state);
    this.dirty = false;
  }

  getBindingState(binding, now = Date.now()) {
    this.load();
    const key = bindingKey(binding);
    if (!this.state.bindings[key]) {
      this.state.bindings[key] = {
        binding: {
          name: binding.name || '',
          apiUrl: binding.apiUrl || '',
          to: binding.to || ''
        },
        firstSeenAt: isoTime(now),
        lastUserMessageAt: '',
        lastUserMessageFingerprint: '',
        lastOutboundAt: '',
        outboundSinceUserMessage: 0,
        pauseReason: '',
        pausedAt: '',
        lastReminderAt: '',
        lastReminderReason: ''
      };
      this.dirty = true;
    } else {
      const state = this.state.bindings[key];
      state.binding = {
        name: binding.name || '',
        apiUrl: binding.apiUrl || '',
        to: binding.to || ''
      };
      if (typeof state.outboundSinceUserMessage !== 'number') state.outboundSinceUserMessage = 0;
      if (!state.firstSeenAt) state.firstSeenAt = isoTime(now);
    }
    return this.state.bindings[key];
  }

  refreshInbound(binding, now = Date.now(), log = () => {}) {
    if (!this.config.enabled) return null;
    const state = this.getBindingState(binding, now);
    const latest = findLatestInbound(binding, this.weclaw, this.options);
    if (!latest) return state;

    const inboundAt = latest.timestamp || now;
    const lastInboundAt = Date.parse(state.lastUserMessageAt || '') || 0;
    const isNewFingerprint = latest.fingerprint && latest.fingerprint !== state.lastUserMessageFingerprint;
    const isNewerTimestamp = latest.timestamp && inboundAt >= lastInboundAt;

    if (isNewFingerprint && (!lastInboundAt || !latest.timestamp || isNewerTimestamp)) {
      const wasPaused = Boolean(state.pauseReason || state.pausedAt);
      state.lastUserMessageAt = isoTime(inboundAt);
      state.lastUserMessageFingerprint = latest.fingerprint;
      state.lastUserMessageSource = latest.source || '';
      state.outboundSinceUserMessage = 0;
      state.pauseReason = '';
      state.pausedAt = '';
      state.lastReminderAt = '';
      state.lastReminderReason = '';
      this.dirty = true;
      if (wasPaused) {
        log(
          `WeClaw conversation guard resumed binding=${bindingLabel(binding)}: user message received at ${formatLocalTime(inboundAt)}`
        );
      }
    }

    return state;
  }

  blockReason(state, units = 1, now = Date.now()) {
    const config = this.config;
    const nextCount = Number(state.outboundSinceUserMessage || 0) + Math.max(1, units);

    if (!state.lastUserMessageAt && config.requireKnownUserMessage) {
      return {
        code: 'awaiting-user-message',
        message: 'no user-initiated WeChat message has been seen for this binding'
      };
    }

    const lastUserMessageAt = Date.parse(state.lastUserMessageAt || '') || 0;
    if (lastUserMessageAt > 0) {
      const maxAgeMs = config.requiredUserMessageHours * 60 * 60 * 1000;
      if (now - lastUserMessageAt >= maxAgeMs) {
        return {
          code: 'stale-user-message',
          message: `last user message is older than ${config.requiredUserMessageHours}h`
        };
      }
    }

    if (nextCount > config.maxOutboundMessages) {
      return {
        code: 'message-count',
        message: `outbound quota would exceed ${config.maxOutboundMessages} messages before the next user message`
      };
    }

    return null;
  }

  shouldAppendReminder(state, units = 1, now = Date.now()) {
    if (!this.config.enabled || !state.lastUserMessageAt) return false;
    const nextCount = Number(state.outboundSinceUserMessage || 0) + Math.max(1, units);
    if (nextCount >= this.config.maxOutboundMessages) return true;

    const lastUserMessageAt = Date.parse(state.lastUserMessageAt || '') || 0;
    if (!lastUserMessageAt) return false;
    const dueAt = lastUserMessageAt + this.config.requiredUserMessageHours * 60 * 60 * 1000;
    const leadMs = this.config.reminderLeadMinutes * 60 * 1000;
    return dueAt - now <= leadMs;
  }

  reminderTextForState(state, reason, now = Date.now()) {
    const parts = [
      reason.message,
      `outboundSinceUserMessage=${Number(state.outboundSinceUserMessage || 0)}/${this.config.maxOutboundMessages}`
    ];
    if (state.lastUserMessageAt) {
      parts.push(`lastUserMessage=${formatLocalTime(state.lastUserMessageAt)}`);
      const dueAt =
        (Date.parse(state.lastUserMessageAt) || now) + this.config.requiredUserMessageHours * 60 * 60 * 1000;
      parts.push(`nextDeadline=${formatLocalTime(dueAt)}`);
    } else {
      parts.push('lastUserMessage=none');
    }
    return parts.join(', ');
  }

  maybeLogReminder(binding, state, reason, now = Date.now(), log = () => {}, force = false) {
    const lastReminderAt = Date.parse(state.lastReminderAt || '') || 0;
    const intervalMs = this.config.reminderIntervalMinutes * 60 * 1000;
    if (!force && lastReminderAt && now - lastReminderAt < intervalMs) return false;

    log(
      `WeClaw conversation reminder binding=${bindingLabel(binding)}: ${this.reminderTextForState(
        state,
        reason,
        now
      )}; ask recipient=${binding.to || 'unknown'} to send any message to the bot before more notifications are sent.`
    );
    state.lastReminderAt = isoTime(now);
    state.lastReminderReason = reason.code;
    this.dirty = true;
    return true;
  }

  beforeSend(binding, units = 1, log = () => {}) {
    if (!this.config.enabled) return { ok: true, appendReminder: false };
    const now = Date.now();
    const state = this.refreshInbound(binding, now, log);
    const reason = this.blockReason(state, units, now);
    if (reason) {
      state.pauseReason = reason.code;
      if (!state.pausedAt) state.pausedAt = isoTime(now);
      this.dirty = true;
      this.maybeLogReminder(binding, state, reason, now, log);
      return { ok: false, reason: reason.code, message: reason.message, state };
    }

    return {
      ok: true,
      appendReminder: this.shouldAppendReminder(state, units, now),
      state
    };
  }

  recordSent(binding, units = 1, log = () => {}) {
    if (!this.config.enabled) return;
    const now = Date.now();
    const state = this.getBindingState(binding, now);
    state.outboundSinceUserMessage = Number(state.outboundSinceUserMessage || 0) + Math.max(1, units);
    state.lastOutboundAt = isoTime(now);
    this.dirty = true;

    if (state.outboundSinceUserMessage >= this.config.maxOutboundMessages) {
      const reason = {
        code: 'message-count',
        message: `outbound quota reached ${state.outboundSinceUserMessage}/${this.config.maxOutboundMessages}`
      };
      state.pauseReason = reason.code;
      state.pausedAt = isoTime(now);
      this.maybeLogReminder(binding, state, reason, now, log, true);
    }
  }

  checkReminder(binding, log = () => {}) {
    if (!this.config.enabled) return null;
    const now = Date.now();
    const state = this.refreshInbound(binding, now, log);
    const reason = this.blockReason(state, 1, now);
    if (reason) {
      state.pauseReason = reason.code;
      if (!state.pausedAt) state.pausedAt = isoTime(now);
      this.dirty = true;
      this.maybeLogReminder(binding, state, reason, now, log);
      return reason;
    }

    if (this.shouldAppendReminder(state, 1, now)) {
      const lastUserMessageAt = Date.parse(state.lastUserMessageAt || '') || now;
      const dueAt = lastUserMessageAt + this.config.requiredUserMessageHours * 60 * 60 * 1000;
      const reason = {
        code: 'conversation-due-soon',
        message: `user message required within ${formatDuration(dueAt - now)}`
      };
      this.maybeLogReminder(binding, state, reason, now, log);
      return reason;
    }

    return null;
  }

  resetBinding(binding) {
    this.load();
    let resetCount = 0;
    for (const [key, value] of Object.entries(this.state.bindings || {})) {
      const storedBinding = (value && value.binding) || parseBindingKey(key);
      if (key === bindingKey(binding) || bindingMatches(binding, storedBinding)) {
        delete this.state.bindings[key];
        resetCount += 1;
      }
    }
    if (resetCount > 0) this.dirty = true;
    return resetCount;
  }
}

function activeBindings(weclaw = {}) {
  return (Array.isArray(weclaw.bindings) ? weclaw.bindings : []).filter(
    (binding) => binding && binding.enabled !== false && binding.apiUrl && binding.to
  );
}

function runWeclawGuardReminderCheck(weclaw = {}, options = {}) {
  const guard = new WeclawConversationGuard(weclaw, options);
  if (weclaw.enabled === false) return { ok: true, skipped: true, reason: 'notifications-disabled' };
  if (!guard.config.enabled) return { ok: true, skipped: true, reason: 'disabled' };

  const results = [];
  for (const binding of activeBindings(weclaw)) {
    const reason = guard.checkReminder(binding, options.log || (() => {}));
    if (reason) {
      results.push({ binding: bindingLabel(binding), reason: reason.code });
    }
  }
  guard.save();
  return { ok: true, reminders: results };
}

module.exports = {
  WeclawConversationGuard,
  appendConversationReminder,
  countPayloadMessages,
  normalizeConversationGuardConfig,
  runWeclawGuardReminderCheck
};
