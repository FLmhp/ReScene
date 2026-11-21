#!/usr/bin/env bash
# Build API/Web images locally, ship them to the production host, and update only
# those two services. Each step records its phase, and a failure either restores
# just the services this run changed or stops and reports the exact state.
set -euo pipefail

VERSION=${1:?usage: deploy_targeted.sh <version> <ssh-host> <remote-root> [api-base-url] [web-base-url]}
REMOTE=${2:?usage: deploy_targeted.sh <version> <ssh-host> <remote-root> [api-base-url] [web-base-url]}
REMOTE_ROOT=${3:?usage: deploy_targeted.sh <version> <ssh-host> <remote-root> [api-base-url] [web-base-url]}
API_URL=${4:-https://api.rescene.xyz}
WEB_URL=${5:-https://app.rescene.xyz}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAGE="$ROOT/.cache/release/$VERSION"
SSH=(ssh -o BatchMode=yes "$REMOTE")
COMPOSE="docker compose --env-file infra/.env -f infra/compose.yaml"
mkdir -p "$STAGE"

PHASE=prepare
CHANGED_API=0
CHANGED_WEB=0
PHASES="$STAGE/phases.log"
: >"$PHASES"

phase() {
  PHASE=$1
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PHASE" | tee -a "$PHASES" >&2
}

# Best-effort note next to the release evidence; a broken SSH link must not hide
# the phase this run reached.
record() {
  "${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'; printf '%s\n' '$1' >> 'releases/$VERSION/status.txt'" >/dev/null 2>&1 || true
}

restore() {
  local service=$1
  "${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
    while read -r name image; do
      case \"\$name\" in
        /rescene-$service|rescene-$service) docker tag \"\$image\" rescene-$service:latest ;;
      esac
    done < 'releases/$VERSION/before-images.txt'
    $COMPOSE up -d --no-deps --no-build $service
    docker inspect --format '{{.Name}} {{.Image}} {{.State.Status}}' rescene-$service"
}

rollback() {
  local status=$?
  trap - ERR
  set +e
  echo "Deployment failed during phase '$PHASE' (status $status)" >&2
  echo "Services changed by this run: api=$CHANGED_API web=$CHANGED_WEB" >&2
  record "failed phase=$PHASE api=$CHANGED_API web=$CHANGED_WEB"
  if [[ "$CHANGED_API" == 0 && "$CHANGED_WEB" == 0 ]]; then
    echo "The host still runs its previous services; nothing to restore." >&2
    exit "$status"
  fi
  if [[ "${RESCENE_COMPAT_VERIFIED:-0}" != 1 ]]; then
    echo "The previous images are not verified against the migrated schema, so nothing is restored." >&2
    echo "Inspect '$REMOTE_ROOT/releases/$VERSION/before-images.txt' before changing the host again." >&2
    exit "$status"
  fi
  # Reverse order: web was replaced last, so it is restored first.
  if [[ "$CHANGED_WEB" == 1 ]] && ! restore web; then
    echo "Restoring web failed; the host may run mixed versions." >&2
    exit "$status"
  fi
  if [[ "$CHANGED_API" == 1 ]] && ! restore api; then
    echo "Restoring api failed; the host may run mixed versions." >&2
    exit "$status"
  fi
  record "restored api=$CHANGED_API web=$CHANGED_WEB"
  echo "Restored the images this run replaced." >&2
  exit "$status"
}

wait_healthy() {
  local service=$1 id status
  id=$("${SSH[@]}" "cd '$REMOTE_ROOT'; docker compose --env-file infra/.env -f infra/compose.yaml ps -q $service")
  [[ -n "$id" ]] || return 1
  for _ in $(seq 1 40); do
    status=$("${SSH[@]}" "docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id" 2>/dev/null || true)
    [[ "$status" == healthy || "$status" == running ]] && return 0
    sleep 3
  done
  return 1
}

# Installed before the first command that could change the host, so every
# failure reports its phase; rollback() only restores services this run changed.
trap rollback ERR

phase prepare
grep -qx "$VERSION" "$ROOT/VERSION" || {
  echo "VERSION is $(cat "$ROOT/VERSION"), not $VERSION" >&2
  exit 2
}
node "$ROOT/scripts/check-versions.mjs"

echo "Building rescene-api:$VERSION and rescene-web:$VERSION"
docker build -f "$ROOT/infra/api/Dockerfile" -t "rescene-api:$VERSION" "$ROOT"
docker build -f "$ROOT/infra/web/Dockerfile" \
  --build-arg "NEXT_PUBLIC_API_URL=$API_URL" -t "rescene-web:$VERSION" "$ROOT"
api_digest=$(docker image inspect --format '{{.Id}}' "rescene-api:$VERSION")
web_digest=$(docker image inspect --format '{{.Id}}' "rescene-web:$VERSION")

echo "Exporting images for transfer"
docker save "rescene-api:$VERSION" "rescene-web:$VERSION" | gzip -1 >"$STAGE/images.tar.gz"

"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'; mkdir -p 'releases/$VERSION' infra/backups
  free=\$(df --output=avail -B1 . | tail -n1); need=\$(( $(stat -c %s "$STAGE/images.tar.gz") * 3 ))
  [ \"\$free\" -ge \"\$need\" ] || { echo \"Insufficient remote disk: free=\$free need=\$need\" >&2; exit 3; }
  $COMPOSE exec -T db pg_dump -U rescene -Fc rescene > 'infra/backups/pre-deploy-$VERSION.dump'
  test -s 'infra/backups/pre-deploy-$VERSION.dump'
  cp -a infra/compose.yaml 'releases/$VERSION/compose.yaml'
  { docker inspect --format '{{.Name}} {{.Image}}' rescene-api rescene-web rescene-db; } > 'releases/$VERSION/before-images.txt'
  cat 'releases/$VERSION/before-images.txt'"

phase transfer
echo "Transferring $VERSION images"
scp -o BatchMode=yes "$STAGE/images.tar.gz" "$REMOTE:$REMOTE_ROOT/releases/$VERSION/images.tar.gz"

phase load
"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
  gzip -dc 'releases/$VERSION/images.tar.gz' | docker load | tee 'releases/$VERSION/load.txt'"

phase api
# Tag and start in one call, and assume the tag landed if the call fails.
CHANGED_API=1
"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
  docker tag 'rescene-api:$VERSION' rescene-api:latest
  $COMPOSE up -d --no-deps --no-build api"
wait_healthy api || { echo "API did not become healthy" >&2; false; }

phase web
CHANGED_WEB=1
"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
  docker tag 'rescene-web:$VERSION' rescene-web:latest
  $COMPOSE up -d --no-deps --no-build web"
wait_healthy web || { echo "Web did not become healthy" >&2; false; }

phase verify
curl --fail --silent --max-time 20 "$API_URL/health/ready" >/dev/null
curl --fail --silent --max-time 20 -o /dev/null "$WEB_URL/"
trap - ERR

record "ok phase=verify api=$CHANGED_API web=$CHANGED_WEB"
"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
  docker inspect --format '{{.Name}} {{.Image}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' rescene-api rescene-web rescene-db \
    | tee 'releases/$VERSION/after-images.txt'"
printf '{"version":"%s","api":"%s","web":"%s","api_url":"%s","web_url":"%s"}\n' \
  "$VERSION" "$api_digest" "$web_digest" "$API_URL" "$WEB_URL" >"$STAGE/deployed.json"
cat "$STAGE/deployed.json"
