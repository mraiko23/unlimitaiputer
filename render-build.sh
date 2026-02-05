#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "------------------------------------------------"
echo "Starting Build Script"
echo "------------------------------------------------"

# Set cache dir explicitly
export PUPPETEER_CACHE_DIR=/opt/render/project/src/.cache/puppeteer

echo "[1/3] Clean install of dependencies..."
npm install

echo "[2/3] Installing Chrome..."
# Ensure dir exists
mkdir -p $PUPPETEER_CACHE_DIR
# Install Chrome
npx puppeteer browsers install chrome

echo "[3/3] Build Complete!"
echo "Check content of cache:"
ls -R $PUPPETEER_CACHE_DIR
echo "------------------------------------------------"
