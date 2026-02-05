#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "------------------------------------------------"
echo "Starting Build Script"
echo "------------------------------------------------"

echo "[1/3] Clean install of dependencies..."
# Ignore scripts to prevent Puppeteer install script from hanging
npm install --ignore-scripts --no-audit

echo "[2/3] Manually installing Chrome..."
# Explicitly use the local binary to avoid npx prompts
node node_modules/puppeteer/lib/cjs/puppeteer/node/install.js || ./node_modules/.bin/puppeteer browsers install chrome

echo "[3/3] Build Complete!"
echo "------------------------------------------------"
