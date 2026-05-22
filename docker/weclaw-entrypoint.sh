#!/bin/sh
set -eu
set -o pipefail 2>/dev/null || true

log_file="${WECLAW_LOG_FILE:-/var/log/weclaw/weclaw.log}"
restart_on_send_failures="${WECLAW_RESTART_ON_SEND_FAILURES:-3}"
restart_failure_window_seconds="${WECLAW_RESTART_FAILURE_WINDOW_SECONDS:-3600}"
restart_on_session_expired="${WECLAW_RESTART_ON_SESSION_EXPIRED:-1}"

mkdir -p "$(dirname "$log_file")"
touch "$log_file"

is_positive_int() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$1" -gt 0 ] ;;
  esac
}

write_log() {
  printf '%s\n' "$1"
  printf '%s\n' "$1" >> "$log_file"
}

watchdog_log() {
  write_log "$(date '+%Y/%m/%d %H:%M:%S') [watchdog] $1"
}

if ! is_positive_int "$restart_failure_window_seconds"; then
  restart_failure_window_seconds=3600
fi

tmp_dir="$(mktemp -d)"
fifo="$tmp_dir/weclaw-output"
mkfifo "$fifo"

weclaw_pid=""
cleanup() {
  if [ -n "$weclaw_pid" ]; then
    kill "$weclaw_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup INT TERM HUP EXIT

/usr/local/bin/weclaw "$@" > "$fifo" 2>&1 &
weclaw_pid="$!"

failure_count=0
failure_window_started=0
restart_requested=0
restart_reason=""

request_restart() {
  restart_requested=1
  restart_reason="$1"
  watchdog_log "$restart_reason; stopping weclaw so Docker can restart the container"
  kill "$weclaw_pid" 2>/dev/null || true
  ( sleep 8; kill -KILL "$weclaw_pid" 2>/dev/null || true ) &
}

while IFS= read -r line; do
  write_log "$line"
  now="$(date +%s)"

  case "$line" in
    *"[api] sent text"*|*"[api] sent media"*|*"[sender] sent reply"*)
      failure_count=0
      failure_window_started=0
      ;;
  esac

  case "$line" in
    *"ret=-14"*|*"session timeout"*|*"session expired"*|*"session has expired"*)
      if [ "$restart_on_session_expired" = "1" ]; then
        request_restart "detected expired WeChat session"
        break
      fi
      ;;
  esac

  case "$line" in
    *"ret=-2"*)
      if [ "$failure_window_started" -eq 0 ] || [ $((now - failure_window_started)) -gt "$restart_failure_window_seconds" ]; then
        failure_window_started="$now"
        failure_count=0
      fi

      failure_count=$((failure_count + 1))
      watchdog_log "send failure ret=-2 count=${failure_count}/${restart_on_send_failures} window=${restart_failure_window_seconds}s"

      if is_positive_int "$restart_on_send_failures" && [ "$failure_count" -ge "$restart_on_send_failures" ]; then
        request_restart "ret=-2 send failures reached ${failure_count}/${restart_on_send_failures}"
        break
      fi
      ;;
  esac
done < "$fifo"

set +e
wait "$weclaw_pid"
status="$?"
set -e

trap - EXIT
rm -rf "$tmp_dir"

if [ "$restart_requested" = "1" ]; then
  watchdog_log "exiting for Docker restart: $restart_reason"
  exit 75
fi

exit "$status"
