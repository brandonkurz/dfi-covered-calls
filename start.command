#!/bin/zsh
# Double-click launcher for the DFi Covered Call Analyzer.
cd "$(dirname "$0")"
NODE="$(command -v node)"
[ -z "$NODE" ] && NODE="/Users/brandonsmac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ ! -x "$NODE" ]; then
  echo "Node.js not found. Install Node or update the path in start.command."
  read -r "?Press Enter to close..."
  exit 1
fi
( sleep 1 && open "http://127.0.0.1:8771" ) &
exec "$NODE" server.js
