#!/bin/sh
# Browser-collector entrypoint: Xvfb + window manager + VNC + noVNC web +
# collector API, all around ONE persistent Chromium profile.
#
# Secrets: VNC_PASSWORD arrives via environment (Coolify secret, never in
# Git) and is only ever written to the VNC passwd file, never logged.
set -eu

: "${VNC_PASSWORD:?VNC_PASSWORD must be set (Coolify env secret, see .env.example)}"
: "${PROFILE_DIR:=/profile}"
: "${SCREEN:=1366x900x24}"
: "${VNC_PORT:=5900}"
: "${NOVNC_PORT:=6080}"

mkdir -p "$PROFILE_DIR" "$HOME/.vnc"

# Store the VNC password ( prompts never appear in logs ).
x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd"

# Virtual display for the headed browser.
Xvfb :99 -screen 0 "$SCREEN" &
XVFB_PID=$!

export DISPLAY=:99

# Lightweight window manager so the browser window is operable via VNC.
openbox &

# VNC server: loopback only — websockify is the only bridge.
x11vnc -display :99 -forever -shared -localhost -rfbauth "$HOME/.vnc/passwd" -rfbport "$VNC_PORT" &
VNC_PID=$!

# noVNC web client -> VNC bridge (Coolify routes a protected domain here).
websockify --web /usr/share/novnc/ "$NOVNC_PORT" "localhost:$VNC_PORT" &
WS_PID=$!

# Collector API in the foreground so container signals behave.
exec node /app/server.js
