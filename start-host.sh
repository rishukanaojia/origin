#!/usr/bin/env bash
# RemoteLink — start everything the HOST laptop needs with one command:
#   the signaling/web server (:8080) and the native input agent (:9091).
cd "$(dirname "$0")/signaling-server" || exit 1

# Prefer the Node 20 in ~/.local (needed for nut.js prebuilds); fall back to system node.
NODE="$HOME/.local/node-v20/bin/node"; [ -x "$NODE" ] || NODE="node"

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies…"
  npm install
fi

# Free our ports from any previous/stray run so we never hit EADDRINUSE.
for P in $(lsof -t -i:8080 -i:9091 2>/dev/null); do kill "$P" 2>/dev/null; done
sleep 1

"$NODE" agent.js &
AGENT_PID=$!
trap 'kill $AGENT_PID 2>/dev/null' EXIT

echo
echo "Open http://localhost:8080/app.html on THIS machine."
echo "On the tab/other device open http://<this-machine-ip>:8080/app.html"
echo "Each shows a permanent ID + access password; enter the other's to connect."
echo

"$NODE" server.js
