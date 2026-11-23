#!/usr/bin/env bash
# Build exactly the CI-approved commit; the remote transaction owns activation and rollback.
set -Eeuo pipefail
[[ $# == 2 ]] || { echo 'Usage: deploy_site.sh <ssh-host> <full-commit>' >&2; exit 2; }
host=$1
requested=$2
[[ $host =~ ^[A-Za-z0-9_.@-]+$ && $requested =~ ^[0-9a-fA-F]{40}$ ]] || { echo 'Invalid host or full commit' >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse --verify "$requested^{commit}")
[[ $commit == "${requested,,}" ]] || { echo 'Commit must be a full commit SHA' >&2; exit 2; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || { echo 'Node 22 required' >&2; exit 2; }
[[ $(pnpm --version) == 10.18.3 ]] || { echo 'pnpm 10.18.3 required' >&2; exit 2; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh run list --repo FLmhp/ReScene --workflow check.yml --commit "$commit" --limit 100 --json databaseId,status,conclusion,url,createdAt > "$work/runs.json"
run=$(node -e 'const a=require(process.argv[1]);a.sort((x,y)=>y.createdAt.localeCompare(x.createdAt));if(!a.length)process.exit(1);console.log(a[0].databaseId)' "$work/runs.json") || { echo 'No matching CI run' >&2; exit 1; }
status=$(node -e 'const a=require(process.argv[1]);let r=a.find(x=>x.databaseId==process.argv[2]);console.log(r.status+" "+(r.conclusion||""))' "$work/runs.json" "$run")
if [[ $status != completed* ]]; then gh run watch "$run" --repo FLmhp/ReScene --exit-status; fi
gh run view "$run" --repo FLmhp/ReScene --json status,conclusion,url,headSha > "$work/run.json"
ci_url=$(node -e 'const r=require(process.argv[1]);if(r.status!=="completed"||r.conclusion!=="success"||r.headSha!==process.argv[2])process.exit(1);console.log(r.url)' "$work/run.json" "$commit") || { echo 'CI is not successful for this commit' >&2; exit 1; }
mkdir "$work/source"
git -C "$root" archive "$commit" | tar -x -C "$work/source"
version=$(tr -d '\r\n' < "$work/source/VERSION")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || { echo 'Invalid VERSION' >&2; exit 1; }
(cd "$work/source" && pnpm install --frozen-lockfile --filter '@rescene/site...' && pnpm --filter @rescene/site typecheck && pnpm --filter @rescene/site build)
python_cmd=
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    python_cmd=$candidate
    break
  fi
done
[[ -n $python_cmd ]] || { echo 'Python 3.9 or newer required' >&2; exit 1; }
"$python_cmd" "$work/source/scripts/site_deploy_config.py" extract "$work/source/infra/caddy/rescene.caddy" "$work/block.caddy"
tar -C "$work/source/apps/site/dist" -czf "$work/site.tar.gz" .
archive_sha=$(sha256sum "$work/site.tar.gz" | cut -d' ' -f1)
block_sha=$(sha256sum "$work/block.caddy" | cut -d' ' -f1)
random=$(node -p 'require("crypto").randomBytes(4).toString("hex")')
id="$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:12}-$random"
upload="/root/rescene-site-upload-$id"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=20)
ssh "${ssh_opts[@]}" "$host" "umask 077; mkdir '$upload'"
scp "${ssh_opts[@]}" "$work/site.tar.gz" "$work/block.caddy" "$work/source/scripts/site_deploy_config.py" "$work/source/scripts/site_deploy_verify.py" "$work/source/scripts/site_deploy_remote.sh" "$host:$upload/"
echo "Transaction $id; record /var/www/rescene-site/deployments/$id.json"
if ssh "${ssh_opts[@]}" "$host" "bash '$upload/site_deploy_remote.sh' '$id' '$commit' '$version' '$archive_sha' '$block_sha' '$ci_url'"; then
  exit 0
fi
# An SSH failure does not establish whether the remote trap completed. Never activate again.
echo 'Remote command failed or disconnected; inspecting transaction and lock' >&2
if ssh "${ssh_opts[@]}" "$host" "bash '$upload/site_deploy_remote.sh' inspect '$id' '$commit'"; then
  exit 0
else
  status=$?
  if [[ $status == 20 ]]; then
    echo "Transaction rolled back; inspect /var/www/rescene-site/deployments/$id.json and /root/rescene-site-backup-$id/" >&2
  else
    echo "Recovery unconfirmed; inspect /var/www/rescene-site/deployments/$id.json and /root/rescene-site-backup-$id/" >&2
  fi
  exit 1
fi
