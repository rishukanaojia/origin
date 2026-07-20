#!/usr/bin/env bash
# RemoteLink — host mode with a PUBLIC URL, for when the viewer is on a
# different network (mobile data, another Wi-Fi, another city).
# Starts: signaling/web server (:8080) + input agent (:9091) + Cloudflare tunnel.
cd "$(dirname "$0")" || exit 1

# Prefer the Node 20 in ~/.local (needed for nut.js prebuilds); fall back to system node.
NODE="$HOME/.local/node-v20/bin/node"; [ -x "$NODE" ] || NODE="node"

if [ ! -d signaling-server/node_modules ]; then
  echo "First run — installing dependencies…"
  (cd signaling-server && npm install)
fi

# Free our ports from any previous/stray run so we never hit EADDRINUSE.
for P in $(lsof -t -i:8080 -i:9091 2>/dev/null); do kill "$P" 2>/dev/null; done
pkill -x cloudflared 2>/dev/null
sleep 1

"$NODE" signaling-server/agent.js &
AGENT_PID=$!
"$NODE" signaling-server/server.js &
SERVER_PID=$!
trap 'kill $AGENT_PID $SERVER_PID 2>/dev/null' EXIT

CF_LOG=$(mktemp)
./cloudflared tunnel --url http://localhost:8080 > "$CF_LOG" 2>&1 &
CF_PID=$!
trap 'kill $AGENT_PID $SERVER_PID $CF_PID 2>/dev/null' EXIT

echo "Starting public tunnel…"
URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "Tunnel failed to start — see $CF_LOG"
else
  echo
  echo "============================================================"
  echo "  RemoteLink is running. Open the SAME app on both machines:"
  echo
  echo "  On this laptop:   http://localhost:8080/app.html"
  echo "  On the tab/other: $URL/app.html"
  echo
  echo "  Each machine shows its permanent ID + access password."
  echo "  Enter the other machine's ID + password to connect."
  echo "  (Public URL is new each run; give the tunnel ~15s.)"
  echo "============================================================"
  echo
fi

wait $SERVER_PID
