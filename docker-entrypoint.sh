#!/bin/sh
set -eu

if [ "$(id -u)" = 0 ]; then
  # DATA_PATH and LOG_PATH default to children of this volume. Never chown /server
  # or custom paths outside the volume, and never follow symlinks out of it.
  mkdir -p /server/data
  ownership_mismatch=$(find /server/data \( ! -user node -o ! -group node \) -print -quit)
  if [ -n "$ownership_mismatch" ]; then
    chown -Rh node:node /server/data
  fi
  exec su-exec node "$@"
fi

exec "$@"
