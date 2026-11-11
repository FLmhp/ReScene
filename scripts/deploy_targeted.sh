#!/usr/bin/env bash
# Build API/Web images locally, ship them to the production host, and update only
# those two services. Every step records enough state to restore the prior images.
set -euo pipefail

VERSION=${1:?usage: deploy_targeted.sh <version> <ssh-host> <remote-root> [api-base-url]}
REMOTE=${2:?usage: deploy_targeted.sh <version> <ssh-host> <remote-root> [api-base-url]}
REMOTE_ROOT=${3:?usage: deploy_targeted.sh <version> <ssh-host> <remote-root> [api-base-url]}
API_URL=${4:-https://api.rescene.xyz}
WEB_URL=${5:-https://app.rescene.xyz}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAGE="$ROOT/.cache/release/$VERSION"
SSH=(ssh -o BatchMode=yes "$REMOTE")
COMPOSE="docker compose --env-file infra/.env -f infra/compose.yaml"
mkdir -p "$STAGE"

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

echo "Transferring $VERSION images"
scp -o BatchMode=yes "$STAGE/images.tar.gz" "$REMOTE:$REMOTE_ROOT/releases/$VERSION/images.tar.gz"
"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
  gzip -dc 'releases/$VERSION/images.tar.gz' | docker load | tee 'releases/$VERSION/load.txt'"

# Tag as latest only after the archive is present so a failed transfer changes nothing.
"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
  docker tag 'rescene-api:$VERSION' rescene-api:latest
  docker tag 'rescene-web:$VERSION' rescene-web:latest
  $COMPOSE up -d --no-deps --no-build api"

rollback() {
  echo "Deployment failed; restoring previous API/Web images" >&2
  "${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
    while read -r name image; do
      case \"\$name\" in
        /rescene-api|rescene-api) docker tag \"\$image\" rescene-api:latest ;;
        /rescene-web|rescene-web) docker tag \"\$image\" rescene-web:latest ;;
      esac
    done < 'releases/$VERSION/before-images.txt'
    $COMPOSE up -d --no-deps --no-build api web
    docker inspect --format '{{.Name}} {{.Image}} {{.State.Status}}' rescene-api rescene-web" || true
  exit 1
}

wait_healthy() {
  local service=$1 id
  id=$("${SSH[@]}" "cd '$REMOTE_ROOT'; docker compose --env-file infra/.env -f infra/compose.yaml ps -q $service")
  [[ -n "$id" ]] || return 1
  for _ in $(seq 1 40); do
    status=$("${SSH[@]}" "docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id" 2>/dev/null || true)
    [[ "$status" == healthy || "$status" == running ]] && return 0
    sleep 3
  done
  return 1
}

trap rollback ERR
wait_healthy api || { echo "API did not become healthy" >&2; false; }

"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'; $COMPOSE up -d --no-deps --no-build web"
wait_healthy web || { echo "Web did not become healthy" >&2; false; }

curl --fail --silent --max-time 20 "$API_URL/health/ready" >/dev/null
curl --fail --silent --max-time 20 -o /dev/null "$WEB_URL/"
trap - ERR

"${SSH[@]}" "set -eu; cd '$REMOTE_ROOT'
  docker inspect --format '{{.Name}} {{.Image}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' rescene-api rescene-web rescene-db \
    | tee 'releases/$VERSION/after-images.txt'"
printf '{"version":"%s","api":"%s","web":"%s","api_url":"%s","web_url":"%s"}\n' \
  "$VERSION" "$api_digest" "$web_digest" "$API_URL" "$WEB_URL" >"$STAGE/deployed.json"
cat "$STAGE/deployed.json"
