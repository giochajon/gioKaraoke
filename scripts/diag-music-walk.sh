#!/usr/bin/env bash
# Run from the gioKaraoke repo root (where .env and docker-compose.yml live).
# Pulls MUSIC_PATH from .env for the host-side symlink check, and reuses the
# same container-internal /music path the indexer itself sees.
set -euo pipefail

ENV_FILE="${1:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "No .env found at $ENV_FILE — pass the path as an argument." >&2
  exit 1
fi

# Plain KEY=VALUE extraction instead of `source` — docker-compose's .env format
# allows unquoted values with spaces (e.g. SONGS_PATH=/home/user/My Music),
# which bash `source` would mis-parse as a command invocation.
get_env() {
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-
}

MUSIC_PATH="$(get_env MUSIC_PATH)"
MUSIC_PATH="${MUSIC_PATH:-./music}"
CONTAINER="${CONTAINER:-giokaraoke-app}"

echo "=== .env MUSIC_PATH: $MUSIC_PATH ==="
echo "=== container: $CONTAINER ==="
echo

echo "--- Host-side symlink scan ($MUSIC_PATH) ---"
find "$MUSIC_PATH" -type l -exec sh -c 'printf "%s -> %s\n" "$1" "$(readlink "$1")"' _ {} \; || echo "(no symlinks or path unreadable from host)"
echo

echo "--- Container-side walk diagnostic (/music, same path server.js uses) ---"
docker cp "$(dirname "$0")/walk-diag.js" "$CONTAINER:/tmp/walk-diag.js"
docker exec "$CONTAINER" node /tmp/walk-diag.js /music
