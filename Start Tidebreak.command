#!/bin/bash
# Double-click to host a Tidebreak match on this Mac.
cd "$(dirname "$0")" || exit 1
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do [ -x "$p/node" ] && PATH="$p:$PATH"; done
if [ -s "$HOME/.nvm/nvm.sh" ] && ! command -v node >/dev/null 2>&1; then . "$HOME/.nvm/nvm.sh"; fi
clear
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Tidebreak needs Node.js (free) on the Mac that hosts the match."
  echo "  Opening the download page now. Install the macOS package,"
  echo "  then double-click 'Start Tidebreak' again."
  echo ""
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi
PORT=${PORT:-8080}
if curl -s -m 1 "http://localhost:$PORT/info" >/dev/null 2>&1; then
  echo "  Tidebreak is already running. Opening the game..."
  open "http://localhost:$PORT"; sleep 2; exit 0
fi
echo "  Starting Tidebreak. The join code for internet play appears in the game menu."
(sleep 1.5; open "http://localhost:$PORT") &
node server.js
