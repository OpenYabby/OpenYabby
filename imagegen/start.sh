#!/bin/bash

# Yabby Image Generation Sidecar Startup Script
# Starts the Python FastAPI service on port 3002.
# Skips cleanly (exit 0) if requirements aren't met, so `concurrently`
# treats it as an optional component instead of a crash.

cd "$(dirname "$0")"

skip() {
  echo ""
  echo "[ImageGen] ⏭  Skipped: $1"
  echo "[ImageGen]    The generate_image tool will be unavailable."
  echo "[ImageGen]    Fix the cause above and re-run \`npm run dev\` (or \`npm run imagegen\`) to enable."
  echo ""
  exit 0
}

# ── Preflight checks ─────────────────────────────────────
# Each fails fast with a one-line reason so the user knows exactly why
# imagegen didn't start (instead of watching a slow pip install on the
# wrong Python or falling back to CPU inference).

# 1. macOS only (host-native because MPS isn't available in Docker)
[[ "$(uname -s)" == "Darwin" ]] || skip "requires macOS (got $(uname -s)). Image generation uses Apple Metal (MPS)."

# 2. Apple Silicon only — Intel Macs don't have MPS
[[ "$(uname -m)" == "arm64" ]] || skip "requires Apple Silicon (got $(uname -m)). M1/M2/M3/M4 only."

# 3. Python 3.10+ — Xcode CLT ships Python 3.9 which is too old for current
#    torch wheels and triggers the slow pip 21.2.4 path. Auto-pick the
#    newest available interpreter from common locations.
PY_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10; do
  if command -v "$cand" >/dev/null 2>&1; then
    PY_BIN="$(command -v "$cand")"
    break
  fi
done

# Fall back to bare `python3` only if it's actually >= 3.10
if [ -z "$PY_BIN" ] && command -v python3 >/dev/null 2>&1; then
  if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    PY_BIN="$(command -v python3)"
  fi
fi

if [ -z "$PY_BIN" ]; then
  skip "Python 3.10+ not found. Install with: brew install python@3.12"
fi

PY_VER=$("$PY_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "unknown")
echo "[ImageGen] Using $PY_BIN (Python $PY_VER)"

# 4. Disk space ≥ 8 GB (torch wheels + diffusers + SDXL weights)
FREE_GB=$(df -g . 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -lt 8 ]; then
  skip "needs ≥8 GB free disk for model weights (have ${FREE_GB} GB)"
fi

# 5. Hugging Face reachable (first run downloads model weights from there)
if ! curl -sf --max-time 3 -o /dev/null https://huggingface.co 2>/dev/null; then
  skip "huggingface.co unreachable — check your internet connection"
fi

# ── Install + run ────────────────────────────────────────
if [ ! -d "venv" ]; then
  echo "[ImageGen] Creating virtual environment with $PY_BIN..."
  "$PY_BIN" -m venv venv || skip "failed to create venv (check Python install)"
fi

# shellcheck source=/dev/null
source venv/bin/activate

echo "[ImageGen] Upgrading pip..."
pip install -q --upgrade pip >/dev/null 2>&1 || true

echo "[ImageGen] Installing dependencies..."
if ! pip install -q -r requirements.txt; then
  skip "pip install failed — see output above"
fi

echo "[ImageGen] Starting image generation service on port 3002..."
exec uvicorn server:app --host 0.0.0.0 --port 3002 --reload
