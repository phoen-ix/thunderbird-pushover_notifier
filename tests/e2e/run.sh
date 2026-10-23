#!/bin/sh
# Runs the end-to-end test in Docker against official Thunderbird builds.
#
#   sh tests/e2e/run.sh                       # default builds, see below
#   TB_BUILDS="latest:de" sh tests/e2e/run.sh
#
# TB_BUILDS lists <version>:<language> pairs; "latest" stands for the current
# release. By default: the oldest supported ESR line (140) and the current
# release in English, plus the current release in German. E2E_VERBOSE=1 shows
# Thunderbird's console, E2E_ARTIFACTS=<dir> keeps screenshots of the options
# page (in <dir>/<version>-<language>/).
set -eu

cd "$(dirname "$0")/../.."

builds="${TB_BUILDS:-140.16.0esr:en-US latest:en-US latest:de}"
case "$builds" in *latest*)
  latest=$(curl -fsI "https://download.mozilla.org/?product=thunderbird-latest&os=linux64&lang=en-US" \
    | sed -n 's|^[Ll]ocation: .*/releases/\([^/]*\)/.*|\1|p' | tr -d '\r')
  builds=$(echo "$builds" | sed "s/latest/$latest/g")
esac

status=0
for build in $builds; do
  version="${build%%:*}"
  lang="${build#*:}"
  image="pushover-notifier-e2e:$version-$lang"
  echo "=== Thunderbird $version ($lang) ==="
  docker build --quiet --tag "$image" --build-arg "TB_VERSION=$version" --build-arg "TB_LANG=$lang" tests/e2e >/dev/null

  artifacts=""
  if [ -n "${E2E_ARTIFACTS:-}" ]; then
    mkdir -p "$E2E_ARTIFACTS/$version-$lang"
    chmod a+rwx "$E2E_ARTIFACTS/$version-$lang"
    artifacts="--volume $(cd "$E2E_ARTIFACTS/$version-$lang" && pwd):/artifacts --env E2E_ARTIFACTS=/artifacts"
  fi
  # shellcheck disable=SC2086 # $artifacts holds several arguments
  docker run --rm --volume "$PWD:/repo:ro" --env E2E_VERBOSE="${E2E_VERBOSE:-}" $artifacts \
    "$image" node tests/e2e/e2e.mjs || status=1
done
exit $status
