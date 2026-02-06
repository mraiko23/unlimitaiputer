#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "Installing dependencies..."
npm install

echo "Installing Chrome for Puppeteer..."
# Install Chrome to a local cache directory
npx puppeteer browsers install chrome --path "$(pwd)/.cache/puppeteer"

echo "Build complete."
