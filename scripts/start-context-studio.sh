#!/usr/bin/env sh
set -eu

PORT="${1:-43117}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(dirname -- "$SCRIPT_DIR")

CONTEXT_STUDIO_PORT="$PORT" exec node --no-warnings "$PLUGIN_ROOT/server.mjs" --open
