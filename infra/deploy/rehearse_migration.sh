#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
database="rescene_release_check_$$"
docker compose --profile tools run --rm backup
dump=$(find "$PWD/backups" -maxdepth 1 -type f -name 'rescene-*.dump' -printf '%T@ %p\n' |
  sort -nr | head -n1 | cut -d ' ' -f2-)
test -s "$dump"
docker exec rescene-db createdb -U rescene "$database"
trap 'docker exec rescene-db dropdb --if-exists -U rescene "$database"' EXIT
docker exec -i rescene-db pg_restore -U rescene --exit-on-error -d "$database" <"$dump"
docker compose run --rm --no-deps -e "RESCENE_REHEARSAL_DB=$database" api python -c '
import os
from sqlalchemy import create_engine, make_url, text
from rescene_api import db

db.engine = create_engine(make_url(db.settings().database_url).set(database=os.environ["RESCENE_REHEARSAL_DB"]))
for _ in range(2):
    db.init_db()
with db.engine.connect() as connection:
    revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
    assert revision
    count = connection.scalar(text("SELECT COUNT(*) FROM reconstruction_jobs"))
    print(f"Migration rehearsal revision={revision}; restored_jobs={count}")
'
