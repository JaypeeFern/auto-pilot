#!/bin/sh
# Browser-collector entrypoint: Xvfb + window manager + VNC + noVNC web +
# collector API, all around ONE persistent Chromium profile.
#
# Secrets: VNC_PASSWORD arrives via environment (Coolify secret, never in
# Git) and is only ever written to the VNC passwd file, never logged.
set -eu

: "${VNC_PASSWORD:?VNC_PASSWORD must be set (Coolify env secret, see .env.example)}"
: "${PROFILE_DIR:=/profile}"
# Keep in sync with server.js's COLLECTOR_VIEWPORT_WIDTH/HEIGHT defaults —
# Chromium's page.setViewport() cannot exceed this X11 display size.
# NOTE: 1920x1080 was tried and reverted — it OOM-crashed Chromium inside
# the browser container's 640m mem_limit mid-collection (Chrome "Aw, Snap!"
# error code 9, observed in production). Raising this again needs either a
# larger mem_limit in docker-compose.yml (browser service) or a smaller
# resolution bump, verified against actual container memory headroom first.
: "${SCREEN:=1366x900x24}"
: "${VNC_PORT:=5900}"
: "${NOVNC_PORT:=6080}"

mkdir -p "$PROFILE_DIR" "$HOME/.vnc"

# Chromium's SingletonLock/SingletonSocket/SingletonCookie in the profile
# dir name the PID and hostname of whichever container instance last held
# it. PROFILE_DIR is a persistent volume that survives container
# recreation, so on every fresh boot these files necessarily reference a
# process from a previous, now-gone container — Chromium refuses to start
# against them ("profile appears to be in use by another process"),
# hanging Puppeteer's launch until it times out and failing the
# healthcheck (observed in production). This entrypoint only ever runs
# once at container start, so any leftover lock here is always stale.
rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/SingletonCookie"

# Store the VNC password ( prompts never appear in logs ).
x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd"

# Virtual display for the headed browser.
Xvfb :99 -screen 0 "$SCREEN" &
XVFB_PID=$!

export DISPLAY=:99

# Wait until Xvfb is actually ready before starting anything that connects
# to the display. Without this, x11vnc (and openbox) can start first, fail
# with XOpenDisplay, and exit — leaving noVNC with no VNC server behind
# it (observed in production logs). Fail loud if Xvfb never comes up.
READY=0
tries=0
while [ "$tries" -lt 100 ]; do
  if [ -S /tmp/.X11-unix/X99 ]; then
    READY=1
    break
  fi
  tries=$((tries + 1))
  sleep 0.2
done
if [ "$READY" -ne 1 ]; then
  echo "Xvfb :99 did not become ready in time; aborting." >&2
  kill "$XVFB_PID" 2>/dev/null || true
  exit 1
fi

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
