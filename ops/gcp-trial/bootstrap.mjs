import { createHash } from "node:crypto";
import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { renderTrialPlan } from "./plan.mjs";

function initialPlan(request, options) {
  const input = JSON.parse(canonicalJson(request));
  if (!input || typeof input !== "object" || Object.hasOwn(input, "startupScriptSha256")) {
    throw new Error("invalid bootstrap request");
  }
  return renderTrialPlan({ ...input, startupScriptSha256: "0".repeat(64) }, options);
}

function worker(plan) {
  return String.raw`set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo 'worker must be unprivileged' >&2; exit 80; }
# The engine deliberately creates a sparse 32 MiB + 1 lockfile to test refusal.
ulimit -f 65536
ulimit -u 128
[ "$(node --version)" = 'v22.23.2' ] || exit 81
cd "$HOME"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --location --fail --silent --show-error --connect-timeout 10 --max-time 120 --max-filesize 67108864 --output source.tar.gz '@SOURCE_URL@'
[ "$(stat -c %s source.tar.gz)" -le 67108864 ]
printf '%s\n' '@SOURCE_HASH@  source.tar.gz' | sha256sum --check --status || { echo 'source checksum mismatch' >&2; exit 82; }
mkdir source
tar --extract --gzip --file source.tar.gz --directory source --strip-components=1 --no-same-owner --no-same-permissions
cd source
npm ci --workspace @api-migrator/engine --include-workspace-root --ignore-scripts --no-audit --no-fund
npm run build --workspace @api-migrator/engine
# Options must precede test paths; npm script suffixes are not runner options.
cd packages/engine
node --import tsx --test --test-concurrency=1 test/*.test.ts
`.replaceAll("@SOURCE_URL@", plan.source.url).replaceAll("@SOURCE_HASH@", plan.source.sha256);
}

export function renderWorker(request, options) {
  return worker(initialPlan(request, options));
}

export function prepareTrial(request, options) {
  const input = JSON.parse(canonicalJson(request));
  const plan = initialPlan(input, options);
  const prefix = String.raw`#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
deadline=@DEADLINE@
stop_at=$((deadline - 90))
[ "$(date +%s)" -lt "$stop_at" ] || { echo 'trial deadline exhausted' >&2; exit 70; }
[ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo 'trial requires root on Linux amd64' >&2; exit 71; }
. /etc/os-release
[ "$ID" = debian ] && [ "$VERSION_ID" = 12 ] || exit 72
root=/var/lib/api-migrator-trial-@RUN@
# Persistent across reboot; existing or interrupted runs are never resumed.
mkdir -m 0711 "$root" || { echo 'duplicate trial refused' >&2; exit 73; }
phase=preflight
finish() {
  code=$?
  trap - EXIT
  status=failed
  if [ "$code" -eq 0 ] && [ "$phase" = complete ]; then status=passed; fi
  printf 'API_MIGRATOR_TRIAL_RESULT {"schemaVersion":1,"profile":"engine-smoke-v1","runId":"@RUN@","sourceRevision":"@REV@","sourceArchiveSha256":"@SOURCE_HASH@","phase":"%s","status":"%s","exitCode":%s,"activationBlocked":true}\n' "$phase" "$status" "$code"
  exit "$code"
}
trap finish EXIT
run_phase() {
  limit=$1
  shift
  remaining=$((stop_at - $(date +%s)))
  [ "$remaining" -gt 0 ] || { echo 'trial deadline exhausted' >&2; return 70; }
  if [ "$remaining" -lt "$limit" ]; then limit=$remaining; fi
  timeout --signal=TERM --kill-after=5s "$limit" "$@"
}
phase=os_prerequisites
run_phase 180 env DEBIAN_FRONTEND=noninteractive apt-get -qq update > "$root/setup.log" 2>&1
run_phase 180 env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends ca-certificates curl xz-utils > "$root/setup.log" 2>&1
phase=node_download
run_phase 150 curl --proto '=https' --proto-redir '=https' --tlsv1.2 --location --fail --silent --show-error --connect-timeout 10 --max-time 120 --max-filesize 67108864 --output "$root/node.tar.xz" '@NODE_URL@'
[ "$(stat -c %s "$root/node.tar.xz")" -le 67108864 ]
printf '%s  %s\n' '@NODE_HASH@' "$root/node.tar.xz" | sha256sum --check --status
mkdir -m 0755 "$root/node"
run_phase 60 tar --extract --xz --file "$root/node.tar.xz" --directory "$root/node" --strip-components=1 --no-same-owner --no-same-permissions
# Extraction honors root's umask; only the verified public runtime is readable.
run_phase 60 chmod -R a+rX "$root/node"
# Root sets up the runtime, but never executes repository or npm code.
phase=worker_setup
account=amt@USER@
if getent passwd "$account" >/dev/null; then exit 74; fi
useradd --system --user-group --no-create-home --home-dir "$root/work" --shell /usr/sbin/nologin "$account"
install -d -m 0700 -o "$account" -g "$account" "$root/work"
phase=engine_smoke
run_phase 1800 runuser -u "$account" -- env -i HOME="$root/work" PATH="$root/node/bin:/usr/bin:/bin" CI=1 npm_config_registry=https://registry.npmjs.org npm_config_update_notifier=false /bin/bash -se > "$root/worker.log" 2>&1 <<'API_MIGRATOR_WORKER'
`;
  const script = prefix.replaceAll("@DEADLINE@", String(Math.floor(plan.deleteAt / 1000)))
    .replaceAll("@RUN@", plan.runId).replaceAll("@USER@", plan.runId.slice(0, 16))
    .replaceAll("@REV@", plan.source.revision).replaceAll("@SOURCE_HASH@", plan.source.sha256)
    .replaceAll("@NODE_URL@", plan.runtime.url).replaceAll("@NODE_HASH@", plan.runtime.sha256)
    + worker(plan) + "API_MIGRATOR_WORKER\nphase=complete\n";
  return { plan: renderTrialPlan({ ...input, startupScriptSha256: createHash("sha256").update(script).digest("hex") },
    { nowMs: plan.issuedAt }), script };
}
