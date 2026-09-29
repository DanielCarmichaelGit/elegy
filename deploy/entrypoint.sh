#!/bin/sh
# Hosting platforms mount volumes owned by root. Fix ownership of the data
# folder, then run the relay as the unprivileged "node" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${QUILT_DATA:-/data}"
  chown -R node:node "${QUILT_DATA:-/data}"
  exec su-exec node "$@"
fi
exec "$@"
