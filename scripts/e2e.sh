#!/usr/bin/env bash
# Runs the end-to-end suite (tests/e2e/run.sh: the add-on in real Thunderbird
# builds in Docker; coverage map: tests/e2e/COVERAGE.md) and keeps its log and
# settings-page screenshots in $ARTIFACTS (default: a temp dir).
#
#   scripts/e2e.sh                         # builds as in run.sh
#   TB_BUILDS="latest:de" scripts/e2e.sh
#
# Starts no compose project and publishes no ports, so PORT_BASE and
# COMPOSE_PROJECT_NAME don't apply. This run's containers are removed on exit,
# also when it is interrupted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="${ARTIFACTS:-$(mktemp -d)}"
mkdir -p "$ARTIFACTS"
export E2E_RUN="run-$$-$(date +%s)"
trap 'docker ps -aq --filter "label=pushover-notifier-e2e=$E2E_RUN" | xargs -r docker rm -f >/dev/null' EXIT

status=0
E2E_ARTIFACTS="$ARTIFACTS/screenshots" sh "$ROOT/tests/e2e/run.sh" 2>&1 | tee "$ARTIFACTS/e2e.log" || status=$?
echo "e2e: log and screenshots in $ARTIFACTS"
exit $status
