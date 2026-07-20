#!/usr/bin/env bash
# RemoteLink desktop app launcher.
# Uses the Node 20 installed in ~/.local and starts the Electron app. The app
# boots its own signaling server + input agent, so there is nothing else to run.
export PATH="$HOME/.local/node-v20/bin:$PATH"
unset ELECTRON_RUN_AS_NODE          # ensure Electron runs as Electron, not plain Node
cd "$(dirname "$0")/desktop-app" || exit 1

if [ ! -d node_modules/electron ]; then
  echo "First run — installing app dependencies…"
  npm install --no-audit --no-fund
fi

exec ./node_modules/.bin/electron . "$@"
