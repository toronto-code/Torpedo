#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 TARGET_INDEX_FILE" >&2
  exit 64
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=$1
cp "$SCRIPT_DIR/index.ts.original" "$TARGET"
shasum -a 256 "$TARGET"
