#!/bin/bash
# ═══════════════════════════════════════════════════════
# Cleanup orphan MCP servers, Chrome instances, and CLI runners
# ═══════════════════════════════════════════════════════
# Run when your Mac lags — kills all MCP zombies without
# touching the running Yabby server on port 3000.
#
# Usage: ./scripts/cleanup-zombies.sh
#        ./scripts/cleanup-zombies.sh --all   (also kills Yabby server)

set -e

KILL_YABBY=false
if [ "$1" = "--all" ]; then
  KILL_YABBY=true
fi

count_before=$(ps aux | grep -cEi "mcp-server|mcp-chrome|mcp-fetch|playwright-mcp|chrome-devtools-mcp|Chrome for Testing|ms-playwright" | grep -v grep || echo 0)

echo "🔍 Found $count_before zombie processes"

# Kill MCP servers
pkill -9 -f "mcp-server-puppeteer" 2>/dev/null || true
pkill -9 -f "mcp-server-filesystem" 2>/dev/null || true
pkill -9 -f "mcp-server-github" 2>/dev/null || true
pkill -9 -f "mcp-fetch" 2>/dev/null || true
pkill -9 -f "playwright-mcp" 2>/dev/null || true
pkill -9 -f "chrome-devtools-mcp" 2>/dev/null || true

# Kill Chrome instances from Puppeteer/Playwright
pkill -9 -f "Chrome for Testing" 2>/dev/null || true
pkill -9 -f "ms-playwright/mcp-chrome" 2>/dev/null || true
pkill -9 -f "puppeteer/chrome" 2>/dev/null || true

# Kill orphan Next.js dev servers spawned by agents
pkill -9 -f "next-server" 2>/dev/null || true
pkill -9 -f "next dev" 2>/dev/null || true

# Kill orphan CLI runners (NOT the VSCode extension, NOT /session)
if [ "$KILL_YABBY" = true ]; then
  # Kill everything — including Yabby server
  pkill -9 -f "claude$" 2>/dev/null || true
  pkill -9 -f "^claude " 2>/dev/null || true
  pkill -9 -f "codex$" 2>/dev/null || true
  pkill -9 -f "^codex " 2>/dev/null || true
  lsof -ti :3000 | xargs kill -9 2>/dev/null || true
  echo "⚠️  Killed Yabby server too"
else
  # Only orphans (parent = init, not spawned by Yabby)
  ps -eo pid,ppid,command | awk '$2==1 && $3=="claude" {print $1}' | xargs -r kill -9 2>/dev/null || true
  ps -eo pid,ppid,command | awk '$2==1 && $3=="codex" {print $1}' | xargs -r kill -9 2>/dev/null || true
fi

sleep 2
count_after=$(ps aux | grep -cEi "mcp-server|mcp-chrome|mcp-fetch|playwright-mcp|chrome-devtools-mcp|Chrome for Testing|ms-playwright" | grep -v grep || echo 0)
killed=$((count_before - count_after))

echo "✅ Killed $killed zombie processes ($count_after remaining)"
echo "📊 Load avg: $(uptime | awk -F'load averages:' '{print $2}')"
