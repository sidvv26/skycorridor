#!/bin/bash
set -e

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "============================================================"
  echo " Node.js is required to run this app but wasn't found."
  echo " Download and install it from https://nodejs.org, then"
  echo " run this script again."
  echo "============================================================"
  echo ""
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies - this takes a minute the first time..."
  npm install
fi

echo ""
echo "Starting SkyCorridor... your browser will open automatically in a few seconds."
echo "Press Ctrl+C to stop the app."
echo ""

( sleep 6 && (open http://localhost:5173 2>/dev/null || xdg-open http://localhost:5173 2>/dev/null) ) &
npm run dev
