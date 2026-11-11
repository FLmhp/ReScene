#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_DEPLOY_ROOT:-/opt/rescene}
CSV=${1:?usage: provision_public.sh RAM_USER_CSV ACCOUNT_ID BUCKET}
ACCOUNT_ID=${2:?missing account id}
BUCKET=${3:?missing bucket}
SECRETS=$ROOT/infra/secrets

[[ -f "$CSV" ]] || { echo "RAM user CSV not found: $CSV" >&2; exit 2; }
install -d -m 700 "$SECRETS" "$ROOT/infra/postgres"
install -d -m 750 -o root -g 65532 "$ROOT/infra/backups"

generate_secret() {
  local path=$1 bytes=$2
  if [[ ! -s "$path" ]]; then
    umask 077
    openssl rand -hex "$bytes" >"$path"
  fi
  chmod 600 "$path"
}

generate_secret "$SECRETS/db_password" 32
generate_secret "$SECRETS/jwt_secret" 32
generate_secret "$SECRETS/worker_token" 32
generate_secret "$SECRETS/admin_password" 24

python3 - "$CSV" "$SECRETS/oss_access_key_secret" "$ROOT/infra/.env" "$ACCOUNT_ID" "$BUCKET" <<'PY'
import csv
import os
import sys
from pathlib import Path

csv_path, secret_path, env_path, account_id, bucket = sys.argv[1:]
with open(csv_path, encoding="utf-8-sig", newline="") as handle:
    rows = list(csv.DictReader(handle))
if len(rows) != 1:
    raise SystemExit("RAM user CSV must contain exactly one row")
row = rows[0]
access_key_id = row.get("AccessKeyId", "").strip()
access_key_secret = row.get("AccessKeySecret", "").strip()
if not access_key_id or not access_key_secret:
    raise SystemExit("RAM user CSV is missing AccessKeyId or AccessKeySecret")

secret = Path(secret_path)
secret.write_text(access_key_secret + "\n", encoding="utf-8")
os.chmod(secret, 0o600)

env = Path(env_path)
env.write_text(
    "\n".join(
        [
            "RESCENE_ADMIN_EMAIL=admin@rescene.xyz",
            "RESCENE_OSS_ENDPOINT=https://oss-cn-beijing.aliyuncs.com",
            "RESCENE_OSS_REGION=oss-cn-beijing",
            f"RESCENE_OSS_BUCKET={bucket}",
            f"RESCENE_OSS_ACCESS_KEY_ID={access_key_id}",
            f"RESCENE_OSS_ROLE_ARN=acs:ram::{account_id}:role/resceneosssessionrole",
            "",
        ]
    ),
    encoding="utf-8",
)
os.chmod(env, 0o600)
PY

rm -f -- "$CSV"
chown root:65532 "$SECRETS"/*
chmod 640 "$SECRETS"/*
printf 'Public server secrets and environment configured in %s\n' "$ROOT/infra"
printf 'Initial admin credentials: admin@rescene.xyz and %s\n' "$SECRETS/admin_password"
