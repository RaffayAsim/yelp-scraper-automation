#!/bin/bash
set -e

# Ensure persistent volume directories exist
mkdir -p /data/chrome-profile /data/exports

# Symlink /app/exports → /data/exports so server.js default paths still work
if [ ! -L /app/exports ]; then
  rm -rf /app/exports
  ln -s /data/exports /app/exports
fi

# Start Xvfb virtual display (required for headless:false + Chrome Extensions)
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
echo "Xvfb started (PID $XVFB_PID) on DISPLAY=:99"

# Give Xvfb a moment to initialize
sleep 1

# Start the Node.js server
exec node server.js
