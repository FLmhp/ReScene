#!/usr/bin/env bash
# Invoked only from the commit archive uploaded by deploy_site.sh.
set -Eeuo pipefail
base=/var/www/rescene-site
conf=/root/docker/caddy/conf
container_identity() {
  docker inspect rescene-api rescene-web rescene-db caddy | python3 -c 'import json,sys; data=json.load(sys.stdin); print(json.dumps([{ "id": c["Id"], "started_at": c["State"]["StartedAt"], "image": c["Image"], "health": c["State"].get("Health", {}).get("Status", c["State"]["Status"]) } for c in data], sort_keys=True))'
}
if [[ ${1:-} == inspect ]]; then
  id=$2; commit=$3
  [[ $id =~ ^[0-9TZ-]+-[0-9a-f]{12}-[0-9a-f]{8}$ && $commit =~ ^[0-9a-f]{40}$ ]] || exit 2
  file="$base/deployments/$id.json"
  # Wait for the original transaction, not a second activation.
  exec 9>/var/lock/rescene-site-deploy.lock
  flock -w 240 9 || { echo 'Original transaction still running; recovery unconfirmed' >&2; exit 1; }
  [[ -f $file ]] || { echo 'No transaction record; recovery unconfirmed' >&2; exit 1; }
  python3 - "$file" "$commit" "$base" <<'PY'
import hashlib, json, os, sys
with open(sys.argv[1], encoding='utf-8') as f:
    r = json.load(f)
print('Transaction phase:', r.get('phase'))
if r.get('commit') != sys.argv[2]:
    raise SystemExit('Transaction record commit mismatch; recovery unconfirmed')
if r.get('phase') == 'rolled_back':
    print('Transaction rolled back; see record and backup', file=sys.stderr)
    raise SystemExit(20)
if r.get('phase') != 'committed':
    raise SystemExit('Transaction did not commit; recovery unconfirmed; see record and backup')
if not os.path.islink(sys.argv[3] + '/current') or os.readlink(sys.argv[3] + '/current') != r.get('new_current'):
    raise SystemExit('Current target differs from committed record; recovery unconfirmed')
for path, key in (('/root/docker/caddy/conf/Caddyfile', 'main_sha256'), ('/root/docker/caddy/conf/rescene.caddy', 'candidate_sha256')):
    with open(path, 'rb') as stream:
        if hashlib.sha256(stream.read()).hexdigest() != r.get(key):
            raise SystemExit('Caddy configuration differs from committed record; recovery unconfirmed')
PY
  upload="/root/rescene-site-upload-$id"
  python3 "$upload/site_deploy_verify.py" verify "$upload/http-baseline.json"
  container_identity | cmp -s - "$upload/containers-baseline"
  exit
fi
[[ $# == 6 ]] || exit 2
id=$1; commit=$2; version=$3; archive_sha=$4; block_sha=$5; ci_url=$6
[[ $id =~ ^[0-9TZ-]+-[0-9a-f]{12}-[0-9a-f]{8}$ && $commit =~ ^[0-9a-f]{40}$ && $archive_sha =~ ^[0-9a-f]{64}$ && $block_sha =~ ^[0-9a-f]{64}$ && $version =~ ^[0-9A-Za-z.-]+$ && $ci_url =~ ^https://github.com/FLmhp/ReScene/actions/runs/[0-9]+$ ]] || exit 2
upload="/root/rescene-site-upload-$id"
backup="/root/rescene-site-backup-$id"
record="$base/deployments/$id.json"
incoming="$base/.incoming-$id"
release="$base/releases/$commit"
next="$conf/rescene.caddy.next-$id"
main_next="$conf/Caddyfile.site-next-$id"
link_next="$base/current.next-$id"
helper="$upload/site_deploy_config.py"
verify="$upload/site_deploy_verify.py"
exec 9>/var/lock/rescene-site-deploy.lock
flock -n 9 || { echo 'Another site deployment holds the lock' >&2; exit 1; }
[[ $(sha256sum "$upload/site.tar.gz" | cut -d' ' -f1) == "$archive_sha" && $(sha256sum "$upload/block.caddy" | cut -d' ' -f1) == "$block_sha" ]] || { echo 'Upload checksum mismatch' >&2; exit 1; }
# Verify Caddy mounts as observed: destination/source and read-only, without dumping config or secrets.
docker inspect caddy | python3 -c 'import json,sys; m=json.load(sys.stdin)[0]["Mounts"]; required={("/root/docker/caddy/conf","/etc/caddy"),("/var/www","/var/www")}; found={(x["Source"],x["Destination"]) for x in m if not x["RW"]}; sys.exit(not required.issubset(found))' || { echo 'Required Caddy read-only mounts differ' >&2; exit 1; }
# Verify both authoritative and public DNS, including absence of IPv6.
dns_answers() {
  local resolver=$1 name=$2 type=$3 response
  # dig can report a timed-out address before a successful answer from the next address.
  if ! response=$(dig +time=5 +tries=1 +noall +comments +answer "@$resolver" "$name" "$type") ||
     ! grep -q '^;; ->>HEADER<<- .*status: NOERROR,' <<< "$response"; then
    echo "DNS query failed at $resolver for $name $type" >&2
    return 1
  fi
  awk '$1 !~ /^;/ && $3 == "IN" && NF >= 5 { print $5 }' <<< "$response"
}

for resolver in dns21.hichina.com 8.8.8.8; do
  a=$(dns_answers "$resolver" rescene.xyz A | sort)
  cname=$(dns_answers "$resolver" www.rescene.xyz CNAME)
  cname=${cname%.}
  aaaa=$(dns_answers "$resolver" rescene.xyz AAAA)
  www_aaaa_answer=$(dns_answers "$resolver" www.rescene.xyz AAAA)
  www_a_answer=$(dns_answers "$resolver" www.rescene.xyz A)
  www_aaaa=$(printf '%s\n' "$www_aaaa_answer" | grep ':' || :)
  www_a=$(printf '%s\n' "$www_a_answer" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort || :)
  [[ $a == 107.151.246.42 && $cname == rescene.xyz && -z $aaaa && -z $www_aaaa && ( -z $www_a || $www_a == 107.151.246.42 ) && ( $resolver != 8.8.8.8 || $www_a == 107.151.246.42 ) ]] || { echo "DNS mismatch at $resolver" >&2; exit 1; }
done
mkdir -p "$base/releases" "$base/assets" "$base/deployments"
chmod 755 "$base" "$base/releases" "$base/assets"
chmod 700 "$base/deployments"
[[ ! -e $base/current || -L $base/current ]] || { echo 'current is not a symlink' >&2; exit 1; }
old_current=$(readlink "$base/current" || :)
main_sha=$(sha256sum "$conf/Caddyfile" | cut -d' ' -f1)
old_sha=$(sha256sum "$conf/rescene.caddy" | cut -d' ' -f1)
mkdir -m 700 "$backup"
cp -p "$conf/Caddyfile" "$backup/Caddyfile"
cp -p "$conf/rescene.caddy" "$backup/rescene.caddy"
container_identity > "$upload/containers-baseline"
python3 "$verify" baseline "$upload/http-baseline.json"
mkdir -m 755 "$incoming"
tar -xzf "$upload/site.tar.gz" -C "$incoming" --no-same-owner --no-same-permissions
find "$incoming" -type d -exec chmod 755 {} +
find "$incoming" -type f -exec chmod 644 {} +
# Reject symlinks and special files in a publishable tree.
[[ -z $(find "$incoming" ! -type f ! -type d -print -quit) ]] || { echo 'Unexpected non-regular artifact' >&2; exit 1; }
if [[ -e $release ]]; then
  [[ -d $release && ! -L $release ]] && [[ -z $(find "$release" ! -type f ! -type d -print -quit) ]] && diff -qr "$incoming" "$release" >/dev/null || { echo 'Existing release differs from build' >&2; exit 1; }
  find "$release" -type d -exec chmod 755 {} +
  find "$release" -type f -exec chmod 644 {} +
  rm -rf "$incoming"
else
  mv -T "$incoming" "$release"
fi
[[ -d $release/assets && ! -L $release/assets ]] || { echo 'Missing assets directory' >&2; exit 1; }
while IFS= read -r -d '' src; do
  rel=${src#"$release/assets/"}; dst="$base/assets/$rel"
  mkdir -p "$(dirname "$dst")"
  if [[ -e $dst || -L $dst ]]; then
    [[ -f $dst && ! -L $dst ]] && cmp -s "$src" "$dst" || { echo "Asset collision: $rel" >&2; exit 1; }
  else
    cp -n "$src" "$dst"
    cmp -s "$src" "$dst" || { echo "Asset collision: $rel" >&2; exit 1; }
    chmod 644 "$dst"
  fi
done < <(find "$release/assets" -type f -print0)
python3 "$helper" compose "$conf/rescene.caddy" "$conf/Caddyfile" "$upload/block.caddy" "$next" "$main_next"
candidate_sha=$(sha256sum "$next" | cut -d' ' -f1)
docker exec caddy caddy validate --config "/etc/caddy/$(basename "$main_next")" --adapter caddyfile
python3 "$helper" record "$record" phase=prepared "commit=$commit" "version=$version" "archive_sha256=$archive_sha" "block_sha256=$block_sha" "candidate_sha256=$candidate_sha" "main_sha256=$main_sha" "original_fragment_sha256=$old_sha" "release=$release" "old_current=$old_current" "new_current=$release" "backup=$backup" "ci_url=$ci_url" "container_baseline=$(cat "$upload/containers-baseline")" "http_baseline=$(cat "$upload/http-baseline.json")" symlink_attempted=false symlink_switched=false fragment_attempted=false fragment_switched=false "utc=$(date -u +%FT%TZ)"
state() { python3 "$helper" record "$record" "$@"; }
current_target() { if [[ -L $base/current ]]; then readlink "$base/current"; elif [[ -e $base/current ]]; then echo INVALID; fi; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
inode() { stat -c '%d:%i' -- "$1" 2>/dev/null; }
rollback() {
  local journal phase link_attempt link_done link_inode frag_attempt frag_done frag_inode cur fragment restore_link=false restore_fragment=false
  trap - ERR EXIT HUP INT TERM
  set +e
  if ! journal=$(python3 - "$record" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding='utf-8'))
phase = r['phase']
if phase not in ('prepared', 'activating', 'committed', 'rolled_back', 'recovery_unconfirmed'):
    raise ValueError('unknown phase')
fields = [phase]
for name in ('symlink', 'fragment'):
    attempted, done = r[name + '_attempted'], r[name + '_switched']
    if type(attempted) is not bool or type(done) is not bool or (done and not attempted):
        raise ValueError('invalid switch journal')
    identity = r.get(name + '_inode', '-')
    if attempted and (not isinstance(identity, str) or not identity.replace(':', '').isdigit() or identity.count(':') != 1):
        raise ValueError('missing switch identity')
    fields.extend((str(attempted).lower(), str(done).lower(), identity))
print(' '.join(fields))
PY
  ); then
    state phase=recovery_unconfirmed 'error=Invalid transaction journal' || :
    echo "Recovery unconfirmed: invalid transaction journal; backup $backup" >&2
    return
  fi
  read -r phase link_attempt link_done link_inode frag_attempt frag_done frag_inode <<< "$journal"
  [[ $phase == committed || $phase == rolled_back || $phase == recovery_unconfirmed ]] && return
  cur=$(current_target); fragment=$(sha "$conf/rescene.caddy")
  # A matching value alone is not ownership: an attempted rename must also leave
  # the exact staged inode at the destination, including the mv-before-journal window.
  if [[ $(sha "$conf/Caddyfile") != "$main_sha" ]]; then
    :
  elif [[ $link_attempt == false && $cur != "$old_current" ]] || [[ $frag_attempt == false && $fragment != "$old_sha" ]]; then
    :
  elif [[ $link_attempt == true && $link_done == true && ( $cur != "$release" || $(inode "$base/current") != "$link_inode" ) ]] || [[ $frag_attempt == true && $frag_done == true && ( $fragment != "$candidate_sha" || $(inode "$conf/rescene.caddy") != "$frag_inode" ) ]]; then
    :
  elif [[ $link_attempt == true && $link_done == false && $cur != "$old_current" && ( $cur != "$release" || $(inode "$base/current") != "$link_inode" ) ]] || [[ $frag_attempt == true && $frag_done == false && $fragment != "$old_sha" && ( $fragment != "$candidate_sha" || $(inode "$conf/rescene.caddy") != "$frag_inode" ) ]]; then
    :
  else
    [[ $link_attempt == true && $cur == "$release" && $(inode "$base/current") == "$link_inode" ]] && restore_link=true
    [[ $frag_attempt == true && $fragment == "$candidate_sha" && $(inode "$conf/rescene.caddy") == "$frag_inode" ]] && restore_fragment=true
    if [[ $restore_link == false && $restore_fragment == false ]]; then
      if python3 "$verify" existing "$upload/http-baseline.json" && container_identity | cmp -s - "$upload/containers-baseline"; then
        state phase=rolled_back 'error=Activation failed; baseline unchanged'
        echo "No switches to restore; baseline confirmed; backup $backup" >&2
      else
        state phase=recovery_unconfirmed 'error=Baseline service check failed'
        echo "Recovery unconfirmed; backup $backup" >&2
      fi
      return
    fi
    # Prepare restoration before the final ownership checks. flock serializes this
    # deployer, not administrators: POSIX rename has no compare-and-swap, so the
    # check-to-rename interval below is the smallest practical critical section.
    if [[ $restore_fragment == true ]]; then
      cp -p "$backup/rescene.caddy" "$conf/rescene.caddy.restore-$id" || { state phase=recovery_unconfirmed 'error=Fragment restore preparation failed'; return; }
    fi
    if [[ $restore_link == true && -n $old_current ]]; then
      ln -s "$old_current" "$link_next.restore" || { state phase=recovery_unconfirmed 'error=Symlink restore preparation failed'; return; }
    fi
    if [[ $restore_fragment == true ]]; then
      [[ $(sha "$conf/Caddyfile") == "$main_sha" && $(sha "$conf/rescene.caddy") == "$candidate_sha" && $(inode "$conf/rescene.caddy") == "$frag_inode" ]] && mv -fT "$conf/rescene.caddy.restore-$id" "$conf/rescene.caddy" || { state phase=recovery_unconfirmed 'error=Fragment ownership changed or restore failed'; echo "Recovery unconfirmed; backup $backup" >&2; return; }
    fi
    if [[ $restore_link == true ]]; then
      if [[ -n $old_current ]]; then
        [[ $(sha "$conf/Caddyfile") == "$main_sha" && $(current_target) == "$release" && $(inode "$base/current") == "$link_inode" ]] && mv -fT "$link_next.restore" "$base/current" || { state phase=recovery_unconfirmed 'error=Symlink ownership changed or restore failed'; echo "Recovery unconfirmed; backup $backup" >&2; return; }
      else
        [[ $(sha "$conf/Caddyfile") == "$main_sha" && $(current_target) == "$release" && $(inode "$base/current") == "$link_inode" ]] && rm "$base/current" || { state phase=recovery_unconfirmed 'error=Symlink ownership changed or removal failed'; echo "Recovery unconfirmed; backup $backup" >&2; return; }
      fi
    fi
    if [[ $(sha "$conf/Caddyfile") != "$main_sha" || $(sha "$conf/rescene.caddy") != "$old_sha" || $(current_target) != "$old_current" ]]; then
      state phase=recovery_unconfirmed 'error=Baseline changed during restoration' || :
      echo "Recovery unconfirmed: baseline changed; backup $backup" >&2
      return
    fi
    if docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile && python3 "$verify" existing "$upload/http-baseline.json" && container_identity | cmp -s - "$upload/containers-baseline"; then
      state phase=rolled_back 'error=Activation or verification failed; baseline restored'
      echo "Rolled back; backup $backup" >&2
    else
      state phase=recovery_unconfirmed 'error=Restore validation, reload, or baseline failed'
      echo "Recovery unconfirmed; backup $backup" >&2
    fi
    return
  fi
  state phase=recovery_unconfirmed 'error=Ownership changed; refusing rollback' || :
  echo "Recovery unconfirmed: ownership changed; backup $backup" >&2
}
on_exit() { local code=$?; if (( code != 0 )); then rollback; fi; }
trap on_exit EXIT
trap 'code=$?; state "original_error=Command failed (exit $code): $BASH_COMMAND" || :; exit "$code"' ERR
trap 'state "original_error=Interrupted by HUP" || :; exit 1' HUP
trap 'state "original_error=Interrupted by INT" || :; exit 1' INT
trap 'state "original_error=Interrupted by TERM" || :; exit 1' TERM
[[ $(sha "$conf/Caddyfile") == "$main_sha" && $(sha "$conf/rescene.caddy") == "$old_sha" && $(current_target) == "$old_current" ]] || { echo 'Baseline changed before activation' >&2; exit 1; }
state phase=activating
if [[ $old_current != "$release" ]]; then
  ln -s "$release" "$link_next"
  state symlink_attempted=true "symlink_inode=$(inode "$link_next")"
  [[ $(sha "$conf/Caddyfile") == "$main_sha" && $(sha "$conf/rescene.caddy") == "$old_sha" && $(current_target) == "$old_current" ]] || { echo 'Baseline changed before symlink switch' >&2; exit 1; }
  mv -fT "$link_next" "$base/current"
  state symlink_switched=true
fi
if [[ $old_sha != "$candidate_sha" ]]; then
  state fragment_attempted=true "fragment_inode=$(inode "$next")"
  [[ $(sha "$conf/Caddyfile") == "$main_sha" && $(sha "$conf/rescene.caddy") == "$old_sha" && $(current_target) == "$release" ]] || { echo 'Baseline changed before fragment switch' >&2; exit 1; }
  mv -fT "$next" "$conf/rescene.caddy"
  state fragment_switched=true
fi
docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
# Wait at most 180 seconds for public certificate and homepage; full acceptance follows.
deadline=$((SECONDS + 180))
until curl --fail --silent --show-error --max-time 5 https://rescene.xyz/ -o /dev/null; do
  (( SECONDS < deadline )) || { echo 'Public HTTPS did not become ready' >&2; exit 1; }
  sleep 5
done
python3 "$verify" verify "$upload/http-baseline.json"
container_identity | cmp -s - "$upload/containers-baseline"
[[ $(sha "$conf/Caddyfile") == "$main_sha" && $(sha "$conf/rescene.caddy") == "$candidate_sha" && $(current_target) == "$release" ]]
state phase=committed 'checks=HTTPS, redirects, assets, headers, existing services and container identities passed' "utc=$(date -u +%FT%TZ)"
trap - EXIT ERR HUP INT TERM
echo "Committed $commit; record $record; backup $backup"
