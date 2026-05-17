#!/bin/sh
set -eu

mkdir -p /app/data /tmp/.X11-unix

if [ "${WEIBO_MONITOR_ENABLE_VNC:-1}" != "0" ]; then
  Xvfb "${DISPLAY:-:99}" -screen 0 "${WEIBO_MONITOR_SCREEN:-1366x768x24}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  sleep 0.5
  x11vnc -display "${DISPLAY:-:99}" -forever -shared -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc/ "0.0.0.0:${WEIBO_MONITOR_NOVNC_PORT:-18790}" localhost:5900 >/tmp/novnc.log 2>&1 &
fi

exec "$@"
