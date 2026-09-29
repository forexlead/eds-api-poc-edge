#!/usr/bin/env bash
# Soft-purge the Adobe CDN in front of the dev environment (docs/purge-demo.md).
#
#   scripts/purge.sh url  "<path>"            PURGE one URL
#   scripts/purge.sh key  "<surrogate-key>"   PURGE everything tagged with a surrogate key
#   scripts/purge.sh both "<key>" "<path>"    function fetch cache (aio, by key), then the CDN URL
#
# The purge key is read from AEM_PURGE_KEY in .env (gitignored) and must match the Cloud
# Manager secret CDN_PURGEKEY_290926 behind config/cdn.yaml's purge-auth. It is never echoed,
# and it is passed to curl on stdin (--config -) so it never shows up in the process list.
# Override the host with AEM_BASE=... if needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${AEM_BASE:-https://publish-p24773-e1522172.adobeaemcloud.com}"

usage() {
  echo "usage: $0 url <path> | key <surrogate-key> | both <key> <path>" >&2
  exit 2
}

# Read one variable from .env without sourcing it (sourcing would execute the file).
read_env() {
  local line
  line="$(grep -E "^$1=" "$ROOT/.env" 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

AEM_PURGE_KEY="$(read_env AEM_PURGE_KEY)"
if [ -z "$AEM_PURGE_KEY" ]; then
  echo "purge.sh: AEM_PURGE_KEY is not set in $ROOT/.env — refusing to run" >&2
  exit 1
fi

# PURGE <url> [extra header]; prints "<status> <label>".
cdn_purge() {
  local url="$1" extra="${2:-}" status
  status="$(
    {
      printf 'header = "X-AEM-Purge-Key: %s"\n' "$AEM_PURGE_KEY"
      printf 'header = "X-AEM-Purge: soft"\n'
      [ -n "$extra" ] && printf 'header = "%s"\n' "$extra"
      true
    } | curl -s -o /dev/null -w '%{http_code}' -X PURGE --config - "$url"
  )" || true # a connection failure still prints (as HTTP 000) instead of dying under set -e
  echo "CDN purge ${extra:+($extra) }$url → HTTP $status"
  [ "${status:0:1}" = 2 ]
}

purge_url() {
  local path="$1"
  [ "${path:0:1}" = / ] || path="/$path"
  cdn_purge "$BASE$path"
}

purge_key() {
  cdn_purge "$BASE/" "Surrogate-Key: $1"
}

cmd="${1:-}"
case "$cmd" in
  url)
    [ $# -eq 2 ] || usage
    purge_url "$2"
    ;;
  key)
    [ $# -eq 2 ] || usage
    purge_key "$2"
    ;;
  both)
    [ $# -eq 3 ] || usage
    echo "Function fetch cache: aio aem edge-functions purge-cache api-poc -k $2 --soft"
    if AIO_SKIP_NEW_VERSION_CHECK=true aio aem edge-functions purge-cache api-poc -k "$2" --soft; then
      echo "Function fetch-cache purge → OK"
    else
      echo "Function fetch-cache purge → FAILED (exit $?)"
      exit 1
    fi
    purge_url "$3"
    ;;
  *)
    usage
    ;;
esac
