import { createHash } from "node:crypto";

// Standalone: embedded verbatim into the root-owned guest emitter as well as
// used against independently reconstructed bytes by the operator classifier.
export function hasBatchSmokeSummary(output) {
  const summaries = new Map();
  const skipLines = [];
  for (const line of output.split("\n")) {
    if (/^# (tests|pass|fail|cancelled|skipped|todo)\b/.test(line)) {
      const summary =
        /^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]*)$/.exec(
          line,
        );
      if (!summary || summaries.has(summary[1])) return false;
      const count = Number(summary[2]);
      if (!Number.isSafeInteger(count)) return false;
      summaries.set(summary[1], count);
    }
    if (/#\s*skip\b/i.test(line)) skipLines.push(line);
    if (/#\s*todo\b/i.test(line) && !/^# todo (0|[1-9][0-9]*)$/.test(line))
      return false;
  }
  if (
    summaries.size !== 6 ||
    summaries.get("pass") <= 0 ||
    summaries.get("fail") !== 0 ||
    summaries.get("cancelled") !== 0 ||
    summaries.get("todo") !== 0
  )
    return false;
  const skipped = summaries.get("skipped");
  if (
    skipped > 1 ||
    summaries.get("tests") !== summaries.get("pass") + skipped ||
    skipLines.length !== skipped
  )
    return false;
  if (skipped === 1) {
    const namedSkip =
      /^ok ([1-9][0-9]*) - Docker runner performs an install then an offline typecheck # SKIP$/.exec(
        skipLines[0],
      );
    if (
      !namedSkip ||
      !Number.isSafeInteger(Number(namedSkip[1])) ||
      Number(namedSkip[1]) > summaries.get("tests")
    )
      return false;
  }
  return true;
}

// Also embedded verbatim into the trusted guest-side log emitter. No repo code
// supplies this function or its run/source context.
export function encodeBatchLog(bytes, context) {
  if (bytes.length > 4_194_304) throw new Error("worker log too large");
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 3072) {
    chunks.push(
      `API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: context.runId, index: chunks.length, data: bytes.subarray(start, start + 3072).toString("base64") })}`,
    );
  }
  const output = bytes.toString("utf8");
  const passed =
    context.exitCode === 0 &&
    context.phase === "complete" &&
    hasBatchSmokeSummary(output);
  return [
    ...chunks,
    `API_MIGRATOR_BATCH_RESULT ${JSON.stringify({
      schemaVersion: 1,
      profile: "batch-engine-smoke-v1",
      ...context,
      status: passed ? "passed" : "failed",
      logBytes: bytes.length,
      logChunks: chunks.length,
      logSha256: createHash("sha256").update(bytes).digest("hex"),
      activationBlocked: true,
    })}`,
  ];
}

export function renderMetadataIsolation() {
  return String.raw`
# A positive root control distinguishes blocked worker access from an unavailable
# metadata server. Never request a token; this nonsensitive endpoint returns an ID.
[ "$(curl --noproxy '*' --silent --show-error --connect-timeout 2 --max-time 5 --output /dev/null --write-out '%{http_code}' -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/id)" = 200 ] || exit 83
nft -f - <<NFT
table inet $table {
 chain output {
  type filter hook output priority -150; policy accept;
  meta skuid $uid ip daddr 169.254.169.254 udp dport 53 accept
  meta skuid $uid ip daddr 169.254.169.254 tcp dport 53 accept
  meta skuid $uid ip daddr 169.254.169.254 reject
  meta skuid $uid ip6 daddr fd20:ce::254 reject
 }
}
NFT
for endpoint in 'http://169.254.169.254/computeMetadata/v1/instance/id' 'http://[fd20:ce::254]/computeMetadata/v1/instance/id'; do
 if runuser -u "$account" -- env -i PATH=/usr/bin:/bin curl --noproxy '*' --silent --connect-timeout 2 --max-time 5 --output /dev/null -H 'Metadata-Flavor: Google' "$endpoint"; then
  echo 'worker metadata isolation failed' >&2
  exit 84
 fi
done
`;
}

// Inputs come only from prepareBatch's strict, canonicalized request.
export function renderBatchScript(input, source) {
  const replacements = {
    "@STOP@": String(Math.floor(input.deleteAt / 1000) - 90),
    "@RUN@": input.runId,
    "@SHORT@": input.runId.slice(0, 16),
    "@REV@": source.revision,
    "@SOURCE_HASH@": source.sha256,
    "@SOURCE_URL@": source.url,
  };
  let script =
    String.raw`#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
stop_at=@STOP@
[ "$(date +%s)" -lt "$stop_at" ] || { echo 'Batch deadline exhausted' >&2; exit 70; }
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
run_phase 180 env DEBIAN_FRONTEND=noninteractive apt-get -qq update
run_phase 180 env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends ca-certificates curl xz-utils nftables
account=amb@SHORT@
if getent passwd "$account" >/dev/null; then exit 74; fi
useradd --system --user-group --no-create-home --home-dir "$root/work" --shell /usr/sbin/nologin "$account"
uid=$(id -u "$account")
table=am_batch_@SHORT@
` +
    renderMetadataIsolation() +
    String.raw`
phase=node_download
run_phase 150 curl --proto '=https' --proto-redir '=https' --tlsv1.2 --location --fail --silent --show-error --connect-timeout 10 --max-time 120 --max-filesize 67108864 --output "$root/node.tar.xz" https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
printf '%s  %s\n' d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307 "$root/node.tar.xz" | sha256sum --check --status
mkdir -m 0755 "$root/node"
run_phase 60 tar --extract --xz --file "$root/node.tar.xz" --directory "$root/node" --strip-components=1 --no-same-owner --no-same-permissions
run_phase 60 chmod -R a+rX "$root/node"
install -d -m 0700 -o "$account" -g "$account" "$root/work"
touch "$root/worker.log"
finish() {
 code=$?
 trap - EXIT
 # The controller is root-owned; the worker cannot replace its runtime/log path.
 "$root/node/bin/node" --input-type=module - "$root/worker.log" "$phase" "$code" <<'BATCH_LOG_EMITTER'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
@ENCODER@
const bytes = readFileSync(process.argv[2]);
const records = encodeBatchLog(bytes, {runId:'@RUN@',sourceRevision:'@REV@',sourceArchiveSha256:'@SOURCE_HASH@',phase:process.argv[3],exitCode:Number(process.argv[4])});
for (const record of records) console.log(record);
BATCH_LOG_EMITTER
 emitted=$?
 if [ "$emitted" -ne 0 ]; then exit 85; fi
 exit "$code"
}
trap finish EXIT
phase=engine_smoke
run_phase 1200 runuser -u "$account" -- env -i HOME="$root/work" PATH="$root/node/bin:/usr/bin:/bin" CI=1 npm_config_registry=https://registry.npmjs.org npm_config_update_notifier=false /bin/bash -se > "$root/worker.log" 2>&1 <<'BATCH_ENGINE_WORKER'
set -euo pipefail
[ "$(id -u)" -ne 0 ] || exit 80
ulimit -f 65536
ulimit -u 128
[ "$(node --version)" = v22.23.2 ] || exit 81
cd "$HOME"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --location --fail --silent --show-error --connect-timeout 10 --max-time 120 --max-filesize 67108864 --output source.tar.gz '@SOURCE_URL@'
printf '%s\n' '@SOURCE_HASH@  source.tar.gz' | sha256sum --check --status || exit 82
mkdir source
tar --extract --gzip --file source.tar.gz --directory source --strip-components=1 --no-same-owner --no-same-permissions
cd source
npm ci --workspace @api-migrator/engine --include-workspace-root --ignore-scripts --no-audit --no-fund
npm run build --workspace @api-migrator/engine
cd packages/engine
node --import tsx --test --test-concurrency=1 test/*.test.ts
BATCH_ENGINE_WORKER
[ "$(date +%s)" -lt "$stop_at" ] || exit 70
phase=complete
`;
  script = script.replace(
    "@ENCODER@",
    `${hasBatchSmokeSummary.toString()}\n${encodeBatchLog.toString()}`,
  );
  for (const [key, value] of Object.entries(replacements))
    script = script.replaceAll(key, value);
  return script;
}
