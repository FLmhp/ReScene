#!/bin/sh
set -eu
export PGPASSWORD="$(cat "$PGPASSWORD_FILE")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
partial=$(mktemp "/backups/.rescene-$stamp.XXXXXX")
trap 'rm -f -- "$partial"' EXIT
pg_dump --format=custom --file="$partial"
pg_restore --list "$partial" >/dev/null
chgrp 65532 "$partial"
chmod 640 "$partial"
mv "$partial" "/backups/rescene-$stamp.dump"
find /backups -type f -name 'rescene-*.dump' -mtime +14 -delete
