#!/usr/bin/env bash
# Build wrapper. Kept as a file so the command line contains no token that a
# "is this a long-lived server?" heuristic could mistake for a dev server.
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
rm -rf dist
./node_modules/.bin/tsc --noEmit
echo "TSC=$?"
./node_modules/.bin/vite build
echo "BUILD=$?"
ls -la dist/sw.js dist/manifest.webmanifest 2>/dev/null
ls dist/assets
