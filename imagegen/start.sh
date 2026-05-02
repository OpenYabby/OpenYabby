#!/bin/bash

# Yabby Image Generation Sidecar Startup Script
# Starts the Python FastAPI service on port 3002
# Requires macOS with Apple Silicon (M1/M2/M3/M4)

cd "$(dirname "$0")"

# Check platform
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[ImageGen] ⚠ Not running on macOS — image generation is Apple-only"
  echo "[ImageGen] Sidecar will NOT start. Generate_image tool will be unavailable."
  exit 0
fi

echo "[ImageGen] Checking Python dependencies..."

if [ ! -d "venv" ]; then
  echo "[ImageGen] Creating virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate

echo "[ImageGen] Installing dependencies..."
pip install -q -r requirements.txt

echo "[ImageGen] Starting image generation service on port 3002..."
uvicorn server:app --host 0.0.0.0 --port 3002 --reload
