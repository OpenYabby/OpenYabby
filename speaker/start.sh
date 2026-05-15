#!/bin/bash

# Yabby Speaker Verification Service Startup Script
# Starts the Python FastAPI service on port 3001.
# Skips cleanly (exit 0) if Python isn't usable, so concurrently
# treats it as an optional component instead of a crash.

cd "$(dirname "$0")"

skip() {
  echo ""
  echo "[Speaker] ⏭  Skipped: $1"
  echo "[Speaker]    Wake-word voice biometrics will be disabled (fail-open)."
  echo "[Speaker]    Fix the cause above and re-run \`npm run dev\` to enable."
  echo ""
  exit 0
}

# ── Preflight: pick a usable Python ≥ 3.10 ───────────────
# Xcode CLT ships Python 3.9 which is too old for current speechbrain/torch
# wheels and triggers the slow pip 21.2.4 path. Auto-pick the newest
# available interpreter from common locations.
PY_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10; do
  if command -v "$cand" >/dev/null 2>&1; then
    PY_BIN="$(command -v "$cand")"
    break
  fi
done

if [ -z "$PY_BIN" ] && command -v python3 >/dev/null 2>&1; then
  if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    PY_BIN="$(command -v python3)"
  fi
fi

if [ -z "$PY_BIN" ]; then
  skip "Python 3.10+ not found. Install with: brew install python@3.12"
fi

PY_VER=$("$PY_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "unknown")
echo "[Speaker] Using $PY_BIN (Python $PY_VER)"

# ── Install + run ────────────────────────────────────────
if [ ! -d "venv" ]; then
  echo "[Speaker] Creating virtual environment with $PY_BIN..."
  "$PY_BIN" -m venv venv || skip "failed to create venv (check Python install)"
fi

# shellcheck source=/dev/null
source venv/bin/activate

echo "[Speaker] Upgrading pip..."
pip install -q --upgrade pip >/dev/null 2>&1 || true

echo "[Speaker] Installing dependencies..."
if ! pip install -q -r requirements.txt; then
  skip "pip install failed — see output above"
fi

echo "[Speaker] Starting speaker verification service on port 3001..."
echo "[Speaker] Enrollment UI: http://localhost:3000/settings (Speaker Verification tab)"
exec uvicorn app:app --host 0.0.0.0 --port 3001 --reload
