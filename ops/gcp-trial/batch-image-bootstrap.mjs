import { renderMetadataIsolation } from './batch-bootstrap.mjs';
import { encodeBatchImageLog, hasBatchImageSummary } from './batch-image-summary.mjs';
import { encodeBatchImageFailure } from './batch-image-failure.mjs';

// Fixed public-source setup only; no request field supplies executable content.
export function renderBatchImageScript(input, source) {
  let script = String.raw`#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
stop_at=@STOP@
[ "$(date +%s)" -lt "$stop_at" ] || { echo 'Batch deadline exhausted' >&2; exit 70; }
task_stop_at=$(($(date +%s) + 1710))
if [ "$task_stop_at" -lt "$stop_at" ]; then stop_at=$task_stop_at; fi
[ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || exit 71
. /etc/os-release
[ "$ID" = debian ] && [ "$VERSION_ID" = 12 ] || exit 72
root=/var/lib/api-migrator-batch-@RUN@
mkdir -m 0711 "$root" || exit 73
phase=setup
run_phase() {
 limit=$1; shift
 remaining=$((stop_at - $(date +%s)))
 [ "$remaining" -gt 0 ] || return 70
 if [ "$remaining" -lt "$limit" ]; then limit=$remaining; fi
 timeout --signal=TERM --kill-after=5s "$limit" "$@"
}
# Inspect, never replace, the managed host's Docker agent/runtime packages.
command -v docker >/dev/null || exit 86
[ -S /var/run/docker.sock ] || exit 86
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_CONFIG="$root/docker-config"
mkdir -m 0700 "$DOCKER_CONFIG"
export DOCKER_HOST=unix:///var/run/docker.sock
run_phase 15 docker info --format '{{json .}}' > "$root/docker-info.json"
run_phase 180 env DEBIAN_FRONTEND=noninteractive apt-get -qq update
run_phase 180 env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends ca-certificates curl xz-utils nftables git procps
phase=node_download
run_phase 150 curl --proto '=https' --proto-redir '=https' --tlsv1.2 --location --fail --silent --show-error --connect-timeout 10 --max-time 120 --max-filesize 67108864 --output "$root/node.tar.xz" https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
printf '%s  %s\n' d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307 "$root/node.tar.xz" | sha256sum --check --status
mkdir -m 0755 "$root/node"
run_phase 60 tar --extract --xz --file "$root/node.tar.xz" --directory "$root/node" --strip-components=1 --no-same-owner --no-same-permissions
run_phase 60 chmod -R a+rX "$root/node"
touch "$root/worker.log"
finish() {
 code=$?
 trap - EXIT
 "$root/node/bin/node" --input-type=module - "$root/worker.log" "$phase" "$code" <<'BATCH_IMAGE_EMITTER'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
@ENCODER@
let bytes = readFileSync(process.argv[2]);
if (bytes.length === 0 && process.argv[3] === 'image_smoke' && Number(process.argv[4]) !== 0) {
  bytes = Buffer.from(encodeBatchImageFailure({stage:'controller_entry',reason:'controller_unavailable',exitCode:Number(process.argv[4]),signal:null}));
}
for (const record of encodeBatchImageLog(bytes, {runId:'@RUN@',sourceRevision:'@REV@',sourceArchiveSha256:'@SOURCE_HASH@',phase:process.argv[3],exitCode:Number(process.argv[4])})) console.log(record);
BATCH_IMAGE_EMITTER
 emitted=$?
 if [ "$emitted" -ne 0 ]; then exit 85; fi
 exit "$code"
}
trap finish EXIT
phase=runtime_admission
"$root/node/bin/node" --input-type=module - "$root/docker-info.json" <<'DOCKER_ADMISSION'
import { readFileSync } from 'node:fs';
const info = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (info.OSType !== 'linux' || info.CgroupVersion !== '2' || !Array.isArray(info.SecurityOptions) || info.SecurityOptions.some(x => /userns|rootless/i.test(x))) process.exit(86);
DOCKER_ADMISSION
account=amb@SHORT@
fixture_account=amf@SHORT@
getent passwd "$account" >/dev/null && exit 74
getent passwd "$fixture_account" >/dev/null && exit 74
useradd --system --user-group --no-create-home --home-dir "$root/work" --shell /usr/sbin/nologin "$account"
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$fixture_account"
uid=$(id -u "$account")
table=am_build_@SHORT@
` + renderMetadataIsolation() + String.raw`
uid=$(id -u "$fixture_account")
build_account=$account
account=$fixture_account
table=am_image_@SHORT@
` + renderMetadataIsolation() + String.raw`
account=$build_account
fixture_uid=$(id -u "$fixture_account")
fixture_gid=$(id -g "$fixture_account")
install -d -m 0700 -o "$account" -g "$account" "$root/work"
phase=public_build
run_phase 600 runuser -u "$account" -- env -i HOME="$root/work" PATH="$root/node/bin:/usr/bin:/bin" CI=1 npm_config_registry=https://registry.npmjs.org npm_config_update_notifier=false /bin/bash -se > "$root/setup.log" 2>&1 <<'BATCH_IMAGE_WORKER'
set -euo pipefail
umask 022
[ "$(id -u)" -ne 0 ] && [ ! -w /var/run/docker.sock ] || exit 80
[ "$(id -G | wc -w)" -eq 1 ] || exit 80
ulimit -f 65536
ulimit -u 128
[ "$(node --version)" = v22.23.2 ] || exit 81
cd "$HOME"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --location --fail --silent --show-error --connect-timeout 10 --max-time 120 --max-filesize 67108864 --output source.tar.gz '@SOURCE_URL@'
printf '%s\n' '@SOURCE_HASH@  source.tar.gz' | sha256sum --check --status || exit 82
mkdir source
tar --extract --gzip --file source.tar.gz --directory source --strip-components=1 --no-same-owner --no-same-permissions
cd source
npm ci --workspace @api-migrator/engine --workspace @api-migrator/db --workspace @api-migrator/app --workspace @api-migrator/runner --include-workspace-root --ignore-scripts --no-audit --no-fund
npm run build:packages
BATCH_IMAGE_WORKER
phase=seal_runtime
# Kill every build-UID process before moving the tree out of its custody. Never
# remove the metadata rules: denial remains installed until VM destruction.
build_uid=$(id -u "$account")
pkill -KILL -u "$build_uid" || [ "$?" -eq 1 ]
for attempt in 1 2 3 4 5; do
 if ! pgrep -u "$build_uid" >/dev/null; then break; fi
 sleep 1
done
if pgrep -u "$build_uid" >/dev/null; then exit 87; fi
mv "$root/work/source" "$root/runtime"
run_phase 60 chown -hR root:root "$root/runtime"
run_phase 60 chmod -R a-w "$root/runtime"
"$root/node/bin/node" --input-type=module - "$root/runtime" <<'SEALED_RUNTIME'
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
function check(path) {
 const s = lstatSync(path);
 if (s.uid !== 0 || s.gid !== 0 || (!s.isSymbolicLink() && (s.mode & 0o222))) throw Error('runtime not sealed');
 if (s.isSymbolicLink()) {
  const target = realpathSync(path);
  if (target !== root && !target.startsWith(root + '/')) throw Error('runtime symlink escapes');
 } else if (s.isDirectory()) for (const entry of readdirSync(path)) check(join(path, entry));
 else if (!s.isFile() || s.nlink !== 1) throw Error('runtime file custody invalid');
}
check(root);
SEALED_RUNTIME
phase=image_build
cd "$root/runtime"
export PATH="$root/node/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Build is trusted public setup, not customer isolation. A failed or killed build
# never reaches a passing record; independent VM deletion is still mandatory.
(ulimit -f 8192; run_phase 600 env -i PATH="$PATH" HOME="$root" DOCKER_CONFIG="$DOCKER_CONFIG" DOCKER_HOST="$DOCKER_HOST" docker build --file ops/publication-runner/image/Dockerfile --iidfile "$root/image.id" .) >> "$root/setup.log" 2>&1
image=$(cat "$root/image.id")
phase=image_smoke
# Controller owns each retained phase/probe container and its cleanup budget.
# Its phase budgets reserve 60 seconds inside the outer guard, even when the
# caller's absolute deadline extends beyond this controller's 1,200-second cap.
controller_stop_at=$(($(date +%s) + 1200))
if [ "$stop_at" -lt "$controller_stop_at" ]; then controller_stop_at=$stop_at; fi
(ulimit -f 65536; run_phase 1200 env -i PATH="$PATH" HOME="$root" DOCKER_CONFIG="$DOCKER_CONFIG" DOCKER_HOST="$DOCKER_HOST" "$root/node/bin/node" ops/gcp-trial/run-batch-image-smoke.mjs --image "$image" --uid "$fixture_uid" --gid "$fixture_gid" --deadline "$((controller_stop_at * 1000))") > "$root/worker.log" 2> "$root/controller.log"
[ "$(date +%s)" -lt "$stop_at" ] || exit 70
phase=complete
`;
  script = script.replace('@ENCODER@', `${hasBatchImageSummary.toString()}\n${encodeBatchImageLog.toString()}\n${encodeBatchImageFailure.toString()}`);
  for (const [key, value] of Object.entries({ '@STOP@': String(Math.floor(input.deleteAt / 1000) - 90), '@RUN@': input.runId,
    '@SHORT@': input.runId.slice(0, 16), '@REV@': source.revision, '@SOURCE_HASH@': source.sha256, '@SOURCE_URL@': source.url }))
    script = script.replaceAll(key, value);
  return script;
}
