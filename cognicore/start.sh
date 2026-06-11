#!/bin/bash

# Yabby CogniCore Experience Service Startup Script
# Starts the Python FastAPI service on port 3003.
# Follows the same pattern as speaker/start.sh and imagegen/start.sh.
# Skips cleanly (exit 0) if requirements aren't met.

cd "$(dirname "$0")"

PORT="${COGNICORE_PORT:-3003}"

skip() {
  echo ""
  echo "[CogniCore] ⏭  Skipped: $1"
  echo "[CogniCore]    The experience layer will be unavailable."
  echo "[CogniCore]    Fix the cause above and re-run \`npm run dev\` to enable."
  echo ""
  exit 0
}

# ── Preflight checks ─────────────────────────────────────

# 1. Python 3.9+ (cognicore-env requires 3.9+)
PY_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3.9; do
  if command -v "$cand" >/dev/null 2>&1; then
    PY_BIN="$(command -v "$cand")"
    break
  fi
done

# Fall back to bare python3
if [ -z "$PY_BIN" ] && command -v python3 >/dev/null 2>&1; then
  if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)' 2>/dev/null; then
    PY_BIN="$(command -v python3)"
  fi
fi

# Windows: try python (no suffix)
if [ -z "$PY_BIN" ] && command -v python >/dev/null 2>&1; then
  if python -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)' 2>/dev/null; then
    PY_BIN="$(command -v python)"
  fi
fi

if [ -z "$PY_BIN" ]; then
  skip "Python 3.9+ not found. Install with: brew install python@3.12 (macOS) or winget install Python.Python.3.12 (Windows)"
fi

PY_VER=$("$PY_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "unknown")
echo "[CogniCore] Using $PY_BIN (Python $PY_VER)"

# ── Install + run ────────────────────────────────────────

if [ ! -d "venv" ]; then
  echo "[CogniCore] Creating virtual environment with $PY_BIN..."
  "$PY_BIN" -m venv venv || skip "failed to create venv (check Python install)"
fi

# Activate venv (cross-platform)
if [ -f "venv/bin/activate" ]; then
  # shellcheck source=/dev/null
  source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
  # shellcheck source=/dev/null
  source venv/Scripts/activate
else
  skip "venv activation script not found"
fi

echo "[CogniCore] Upgrading pip..."
pip install -q --upgrade pip >/dev/null 2>&1 || true

echo "[CogniCore] Installing dependencies (cognicore-env + FastAPI)..."
if ! pip install -q -r requirements.txt; then
  skip "pip install failed — see output above"
fi

echo "[CogniCore] Starting CogniCore experience service on port $PORT..."
exec uvicorn server:app --host 0.0.0.0 --port "$PORT" --reload
