#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(grep -oE '"version"\s*:\s*"[^"]+"' "$ROOT_DIR/manifest.json" | head -n1 | sed -E 's/.*"([^"]+)"/\1/')"
DISPLAY_NAME="$(grep -oE '"name"\s*:\s*"[^"]+"' "$ROOT_DIR/manifest.json" | head -n1 | sed -E 's/.*"([^"]+)"/\1/' | sed -E 's/[[:space:]]+v[0-9]+(\.[0-9]+)*$//')"
PACKAGE_SLUG="$(printf '%s' "$DISPLAY_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"

shopt -s nullglob
MAX_REV=0
for existingZip in "$ROOT_DIR"/"${PACKAGE_SLUG}-extension-v${VERSION}-r"*.zip; do
  fileName="$(basename "$existingZip")"
  revPart="${fileName#${PACKAGE_SLUG}-extension-v${VERSION}-r}"
  revPart="${revPart%.zip}"
  if [[ "$revPart" =~ ^[0-9]+$ ]]; then
    revNum=$((10#$revPart))
    if (( revNum > MAX_REV )); then
      MAX_REV=$revNum
    fi
  fi
done

NEXT_REV="$(printf '%03d' $((MAX_REV + 1)))"
OUT_NAME="${PACKAGE_SLUG}-extension-v${VERSION}-r${NEXT_REV}.zip"
LATEST_NAME="${PACKAGE_SLUG}-extension-latest.zip"
OUT_PATH="$ROOT_DIR/$OUT_NAME"
LATEST_PATH="$ROOT_DIR/$LATEST_NAME"

cd "$ROOT_DIR"

rm -f "$LATEST_PATH"

zip -r "$OUT_PATH" . \
  -x ".git/*" \
     ".venv/*" \
     ".venv-icons/*" \
     "__pycache__/*" \
     "*.DS_Store" \
  "scripts/build_release_zip.sh" \
  "*.zip"

cp "$OUT_PATH" "$LATEST_PATH"

echo "Created: $OUT_PATH"
echo "Updated: $LATEST_PATH"
