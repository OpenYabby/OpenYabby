#!/bin/bash

# Yabby Speaker Verification Service Startup Script
# Starts the Python FastAPI service on port 3001

cd "$(dirname "$0")"

echo "[Speaker] Checking Python dependencies..."

# Check if virtual environment exists
if [ ! -d "venv" ]; then
  echo "[Speaker] Creating virtual environment..."
  python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install/update dependencies
echo "[Speaker] Installing dependencies..."
pip install -q -r requirements.txt

# Start service
echo "[Speaker] Starting speaker verification service on port 3001..."
echo "[Speaker] Enrollment UI: http://localhost:3000/settings (Speaker Verification tab)"
uvicorn app:app --host 0.0.0.0 --port 3001 --reload
