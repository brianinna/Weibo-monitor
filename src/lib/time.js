const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

function getTimeZone() {
  return process.env.WEIBO_MONITOR_TIME_ZONE || process.env.TZ || DEFAULT_TIME_ZONE;
}

function formatTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: getTimeZone(),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

module.exports = { formatTimestamp, getTimeZone };
