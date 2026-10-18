#!/bin/sh
set -eu

# Chrome and the read-only accessibility reader must share one session bus.
# Run as the existing desktop user; dbus-run-session also reaps its own daemon.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  exec dbus-run-session -- "$0" "$@"
fi

display="${DISPLAY:-:99}"
screen="${DESKTOP_SCREEN:-1280x800x24}"
vnc_port="${DESKTOP_VNC_PORT:-5900}"
ws_port="${DESKTOP_WEBSOCKET_PORT:-6080}"
cdp_port="${DESKTOP_CDP_PORT:-9222}"
start_url="${DESKTOP_START_URL:-about:blank}"

xvfb_pid= openbox_pid= vnc_pid= ws_pid= cdp_pid= browser_pid= workspace_pid=
Xvfb "$display" -screen 0 "$screen" -nolisten tcp -ac >/run/desktop/xvfb.log 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" "$openbox_pid" "$vnc_pid" "$ws_pid" "$cdp_pid" "$browser_pid" "$workspace_pid" 2>/dev/null || true' INT TERM EXIT

# Internal-only native files and PTY transport. Runs with the same desktop UID.
/usr/bin/python3 /usr/local/bin/workspace-bridge >/run/desktop/workspace-bridge.log 2>&1 &
workspace_pid=$!

i=0
until xdpyinfo -display "$display" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 50 ] || { echo "Xvfb did not become ready" >&2; exit 1; }
  sleep 0.1
done

# The browser display has no desktop shell or dock. Window-manager rules also
# maximize later Chrome windows (including incognito), not only the first one.
rm -f /run/desktop/openbox.ready
openbox --config-file /etc/openclawbot/browser-openbox.xml \
  --startup 'touch /run/desktop/openbox.ready' >/run/desktop/openbox.log 2>&1 &
openbox_pid=$!
i=0
# EWMH ownership is published before Openbox loads themes and registers its
# event handlers. Its startup callback runs only after window management is ready.
until [ -f /run/desktop/openbox.ready ]; do
  i=$((i + 1))
  if ! kill -0 "$openbox_pid" 2>/dev/null || [ "$i" -ge 150 ]; then
    echo "Browser window manager did not become ready" >&2
    tail -n 30 /run/desktop/openbox.log >&2
    exit 1
  fi
  sleep 0.1
done
mkdir -p /home/desktop/Downloads

# x11vnc is loopback-only. The app-facing websocket bridge is the only VNC
# transport exposed on the container network; it has no unauthenticated host port.
x11vnc -display "$display" -rfbport "$vnc_port" -localhost -forever -shared -nopw -quiet >/run/desktop/x11vnc.log 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc "$ws_port" "127.0.0.1:$vnc_port" >/run/desktop/websockify.log 2>&1 &
ws_pid=$!

# Do not add --no-sandbox. Chrome's Linux sandbox must remain enabled.
ACCESSIBILITY_ENABLED=1 google-chrome \
  --display="$display" \
  --user-data-dir=/home/desktop/chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --force-renderer-accessibility \
  --start-maximized \
  --no-first-run --no-default-browser-check \
  "$start_url" >/run/desktop/chromium.log 2>&1 &
browser_pid=$!

socat "TCP-LISTEN:$cdp_port,bind=0.0.0.0,reuseaddr,fork" TCP:127.0.0.1:9223 >/run/desktop/socat.log 2>&1 &
cdp_pid=$!


# Separate views share this container's home and network, not another VM.
# Browser stays on :99; Files and Terminal get independent X displays.
for view in files terminal; do
  if [ "$view" = files ]; then view_display=:100; view_vnc=5901; view_ws=6081; else view_display=:101; view_vnc=5902; view_ws=6082; fi
  Xvfb "$view_display" -screen 0 "$screen" -nolisten tcp -ac >/run/desktop/"$view"-xvfb.log 2>&1 &
  n=0
  until xdpyinfo -display "$view_display" >/dev/null 2>&1; do
    n=$((n+1)); [ "$n" -lt 50 ] || exit 1; sleep 0.1
  done
  DISPLAY="$view_display" openbox >/run/desktop/"$view"-openbox.log 2>&1 &
  x11vnc -display "$view_display" -rfbport "$view_vnc" -localhost -forever -shared -nopw -quiet >/run/desktop/"$view"-vnc.log 2>&1 &
  websockify --web=/usr/share/novnc "$view_ws" "127.0.0.1:$view_vnc" >/run/desktop/"$view"-ws.log 2>&1 &
  if [ "$view" = files ]; then
    DISPLAY="$view_display" pcmanfm --no-desktop /home/desktop >/run/desktop/files.log 2>&1 &
  else
    DISPLAY="$view_display" xterm -fa Monospace -fs 12 -geometry 110x36 -title "OCI Workspace" >/run/desktop/terminal.log 2>&1 &
  fi
done
wait "$browser_pid"
