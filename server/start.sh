#!/bin/bash
# Echo Sierra WebSocket Signaling Server — startup script
# Place in: ~/Projects/echo-sierra-server/
# Run: ./start.sh

cd "$(dirname "$0")"

echo "[ES] Starting Echo Sierra signaling server..."
echo "[ES] WebSocket: ws://localhost:8765"
echo "[ES] Health:    http://localhost:8766/health"
echo "[ES] Tunnel:    wss://waypoint-zero.swisschatbot.ch"
echo ""

# Ensure dependencies
if [ ! -d "node_modules" ]; then
  echo "[ES] Installing dependencies..."
  npm install
fi

# Start the server
exec node server.js
