#!/bin/sh
set -eu
set -o pipefail 2>/dev/null || true

log_file="${WECLAW_LOG_FILE:-/var/log/weclaw/weclaw.log}"
restart_on_send_failures="${WECLAW_RESTART_ON_SEND_FAILURES:-3}"
restart_failure_window_seconds="${WECLAW_RESTART_FAILURE_WINDOW_SECONDS:-3600}"
restart_on_session_expired="${WECLAW_RESTART_ON_SESSION_EXPIRED:-1}"
restart_limit="${WECLAW_RESTART_LIMIT:-2}"
restart_limit_window_seconds="${WECLAW_RESTART_LIMIT_WINDOW_SECONDS:-900}"
watchdog_state_file="${WECLAW_WATCHDOG_STATE_FILE:-${log_file}.watchdog.state}"

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
if ! is_positive_int "$restart_limit_window_seconds"; then
  restart_limit_window_seconds=900
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

read_restart_state() {
  restart_state_started=0
  restart_state_count=0
  if [ -f "$watchdog_state_file" ]; then
    # shellcheck disable=SC2034
    read -r restart_state_started restart_state_count < "$watchdog_state_file" || true
  fi
  case "${restart_state_started:-}" in ''|*[!0-9]*) restart_state_started=0 ;; esac
  case "${restart_state_count:-}" in ''|*[!0-9]*) restart_state_count=0 ;; esac
}

record_restart_attempt() {
  if ! is_positive_int "$restart_limit"; then
    return 0
  fi

  now="$(date +%s)"
  read_restart_state
  if [ "$restart_state_started" -eq 0 ] || [ $((now - restart_state_started)) -gt "$restart_limit_window_seconds" ]; then
    restart_state_started="$now"
    restart_state_count=0
  fi

  if [ "$restart_state_count" -ge "$restart_limit" ]; then
    watchdog_log "restart limit reached count=${restart_state_count}/${restart_limit} window=${restart_limit_window_seconds}s; preserved WeClaw login did not recover, rebind required"
    return 1
  fi

  restart_state_count=$((restart_state_count + 1))
  printf '%s %s\n' "$restart_state_started" "$restart_state_count" > "$watchdog_state_file"
  return 0
}

request_restart() {
  if ! record_restart_attempt; then
    failure_count=0
    failure_window_started=0
    return 1
  fi

  restart_requested=1
  restart_reason="$1"
  watchdog_log "$restart_reason; stopping weclaw so Docker can restart the container"
  kill "$weclaw_pid" 2>/dev/null || true
  ( sleep 8; kill -KILL "$weclaw_pid" 2>/dev/null || true ) &
  return 0
}

while IFS= read -r line; do
  write_log "$line"
  now="$(date +%s)"

  case "$line" in
    *"[api] sent text"*|*"[api] sent media"*|*"[sender] sent reply"*)
      failure_count=0
      failure_window_started=0
      rm -f "$watchdog_state_file"
      ;;
  esac

  case "$line" in
    *"ret=-14"*|*"session timeout"*|*"session expired"*|*"session has expired"*)
      if [ "$restart_on_session_expired" = "1" ]; then
        request_restart "detected expired WeChat session" && break
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
        request_restart "ret=-2 send failures reached ${failure_count}/${restart_on_send_failures}" && break
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
