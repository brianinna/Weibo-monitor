#!/bin/sh
set -eu
set -o pipefail 2>/dev/null || true

log_file="${WECLAW_LOG_FILE:-/var/log/weclaw/weclaw.log}"
mkdir -p "$(dirname "$log_file")"
touch "$log_file"

/usr/local/bin/weclaw "$@" 2>&1 | tee -a "$log_file"
