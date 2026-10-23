#!/usr/bin/env bash
# Regenerate the docs screenshots: runs the end-to-end test (tests/e2e/run.sh)
# in the current Thunderbird release, in English and German, and keeps the
# settings-page screenshots it takes (English set + German hero).
#
#   scripts/docs-screenshots.sh [outdir]      # default: docs/screenshots
#
# TB_BUILDS (default "latest:en-US latest:de"): the builds, as in run.sh.
# ARTIFACTS: where the raw screenshots go (default: a temp dir). Needs Docker;
# starts no compose project and publishes no ports. The test images
# (pushover-notifier-e2e:<version>-<language>) stay as a cache, as with
# `npm run test:e2e`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/docs/screenshots}"
ARTIFACTS="${ARTIFACTS:-$(mktemp -d)}"
mkdir -p "$OUT"

E2E_ARTIFACTS="$ARTIFACTS" TB_BUILDS="${TB_BUILDS:-latest:en-US latest:de}" sh "$ROOT/tests/e2e/run.sh"

cp "$ARTIFACTS"/*-en-US/*.png "$OUT/"
cp "$ARTIFACTS"/*-de/options-settings.png "$OUT/options-settings.de.png"
echo "docs-screenshots: $(find "$OUT" -name '*.png' | wc -l) PNGs in $OUT"
