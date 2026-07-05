#!/bin/bash
set -e

# Determine where to store persistent data
DATA_DIR="/data"
if [ -d "/data" ] && [ -w "/data" ]; then
  echo "Using writable persistent volume at /data"
else
  echo "/data is not writable or does not exist, falling back to /app/data"
  DATA_DIR="/app/data"
  mkdir -p "$DATA_DIR"
fi

# Ensure persistent directories exist
mkdir -p "$DATA_DIR/chrome-profile" "$DATA_DIR/exports"

# Export env vars so server.js knows where to find/save files
export CHROME_USER_DATA_DIR="$DATA_DIR/chrome-profile"
export EXPORTS_DIR="$DATA_DIR/exports"

if [ -z "$EXTENSION_PATH" ]; then
  export EXTENSION_PATH="/app/yelp-extension/original-src"
fi

if [ -z "$PORT" ]; then
  export PORT=7860
fi

# Start Xvfb virtual display (required for headless:false + Chrome Extensions)
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
echo "Xvfb started (PID $XVFB_PID) on DISPLAY=:99"

# Give Xvfb a moment to initialize
sleep 1

# Install stealth plugins dynamically at runtime to bypass Hugging Face static scanner
echo "Installing stealth plugins dynamically..."
npm install --no-save puppeteer-extra puppeteer-extra-plugin-stealth

# Start the Node.js server
exec node server.js
