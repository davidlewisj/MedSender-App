#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(grep -oE '"version"\s*:\s*"[^"]+"' "$ROOT_DIR/manifest.json" | head -n1 | sed -E 's/.*"([^"]+)"/\1/')"
STAMP="$(date +%Y%m%d)"
OUT_NAME="MedSender-App-package-v${VERSION}-${STAMP}.zip"
OUT_PATH="$ROOT_DIR/$OUT_NAME"

cd "$ROOT_DIR"

rm -f "$OUT_PATH"

zip -r "$OUT_PATH" . \
  -x ".git/*" \
     ".venv/*" \
     ".venv-icons/*" \
     "__pycache__/*" \
     "*.DS_Store" \
     "scripts/build_release_zip.sh"

echo "Created: $OUT_PATH"
