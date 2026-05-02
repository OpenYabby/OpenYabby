#!/bin/bash
# restart-server.sh — Kill existing Yabby server and restart with npm run dev
# Usage: ./scripts/restart-server.sh

cd "$(dirname "$0")/.." || exit 1

# Detect port from .env or default
PORT=$(grep "^PORT=" .env 2>/dev/null | cut -d= -f2)
PORT=${PORT:-3000}

echo "🔄 Restarting Yabby server on port $PORT..."

# Kill any process listening on that port
PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$PID" ]; then
  echo "   Killing PID $PID (port $PORT)"
  kill $PID 2>/dev/null
  sleep 1
  # Force kill if still alive
  kill -9 $PID 2>/dev/null
else
  echo "   No process on port $PORT"
fi

# Also kill speaker service (port 3001)
SPID=$(lsof -ti :3001 2>/dev/null)
if [ -n "$SPID" ]; then
  echo "   Killing speaker PID $SPID (port 3001)"
  kill $SPID 2>/dev/null
fi

sleep 1

echo "🚀 Starting npm run dev..."
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
npm run dev
