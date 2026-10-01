import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const DEPLOYMENT = fileURLToPath(new URL("../", import.meta.url));
const CLEANUP = readFileSync(`${DEPLOYMENT}cleanup-runner.sh`, "utf8");
const WRAPPER = readFileSync(`${DEPLOYMENT}../run-credential-free-preview.sh`, "utf8");
const LEGACY = `api_migrator_${"d".repeat(16)}`;
const GATEWAY = `api_migrator_gw_${"d".repeat(16)}`;

function quote(value) { return `'${String(value).replaceAll("'", "'\"'\"'")}'`; }

// Run the real dormant shell boundary with command functions scoped to this
// subprocess. No live cleanup entrypoint, host identity or network is touched.
function execute(source, options = {}) {
  const fixture = `
set -Eeuo pipefail
PATH=/usr/bin:/bin
runner_uid=12001
gateway_uid=12002
subuid_start=131072
subuid_end=196607
legacy_table=${quote(LEGACY)}
gateway_table=${quote(GATEWAY)}
legacy_exists=1
gateway_exists=1
deleted=0
runner_status=${options.runnerStatus ?? 1}
gateway_status=${options.gatewayStatus ?? 1}
ps_status=${options.psStatus ?? 0}
awk_status=${options.awkStatus ?? 0}
find_status=${options.findStatus ?? 0}
nft_status=${options.nftStatus ?? 0}
jq_status=${options.jqStatus ?? 0}
delete_status=${options.deleteStatus ?? 0}
fail_after_delete=${options.failAfterDelete ? 1 : 0}
malformed_nft=${options.malformedNft ? 1 : 0}
nft_snapshot_override=${quote(options.nftSnapshot ?? "")}
process_uids=${quote(options.processUids ?? "    0\n    501")}
workspace=${quote(options.workspace ?? "")}
record() { printf '%s\\n' "$*" >&3; }
refuse() { printf 'runner cleanup refused: %s\\n' "$1" >&2; exit 1; }
pgrep() {
  record "pgrep $*"
  if [[ $2 == "$runner_uid" ]]; then return "$runner_status"; fi
  return "$gateway_status"
}
ps() { record "ps $*"; printf '%s\\n' "$process_uids"; return "$ps_status"; }
awk() { record "awk"; (( awk_status == 0 )) || return "$awk_status"; /usr/bin/awk "$@"; }
find() { record "find $*"; printf '%s' "$workspace"; return "$find_status"; }
jq() { record "jq"; (( jq_status == 0 )) || return "$jq_status"; /usr/bin/jq "$@"; }
nft() {
  record "nft $*"
  if [[ $1 == delete ]]; then
    (( delete_status == 0 )) || return "$delete_status"
    [[ $4 != "$legacy_table" ]] || legacy_exists=0
    [[ $4 != "$gateway_table" ]] || gateway_exists=0
    deleted=1
    return 0
  fi
  (( nft_status == 0 )) || return "$nft_status"
  (( fail_after_delete == 0 || deleted == 0 )) || return 2
  if [[ $1 == list && $2 == table ]]; then
    if [[ $4 == "$legacy_table" ]]; then (( legacy_exists == 1 )); else (( gateway_exists == 1 )); fi
    return $?
  fi
  if [[ -n $nft_snapshot_override ]]; then printf '%s' "$nft_snapshot_override"; return 0; fi
  if (( malformed_nft == 1 )); then printf '{"nftables":null}'; return 0; fi
  printf '{"nftables":[{"metainfo":{}}'
  if (( legacy_exists == 1 )); then printf ',{"table":{"family":"inet","name":"%s"}}' "$legacy_table"; fi
  if (( gateway_exists == 1 )); then printf ',{"table":{"family":"inet","name":"%s"}}' "$gateway_table"; fi
  printf ',{"table":{"family":"inet","name":"unrelated_policy"}}]}\\n'
}
`;
  const result = spawnSync("/bin/bash", ["-s"], {
    input: `${fixture}\n${source}\n`, encoding: "utf8", env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe"], timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { ...result, calls: result.output[3].trim().split("\n").filter(Boolean) };
}

const boundaryStart = CLEANUP.indexOf("# KillMode=control-group");
assert(boundaryStart !== -1);
const boundary = CLEANUP.slice(boundaryStart);

function deletions(result) { return result.calls.filter((line) => line.startsWith("nft delete ")); }
function retained(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(deletions(result), []);
}

test("ExecStopPost removes only exact job tables after successful idle observations", () => {
  const result = execute(boundary);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(deletions(result), [`nft delete table inet ${LEGACY}`, `nft delete table inet ${GATEWAY}`]);
  const firstDelete = result.calls.findIndex((line) => line.startsWith("nft delete "));
  for (const proof of ["pgrep -u 12001", "pgrep -u 12002", "ps -e -o uid=", "awk", "find /var/tmp"]) {
    assert(result.calls.slice(0, firstDelete).some((line) => line.startsWith(proof)), proof);
  }
  assert(result.calls.slice(firstDelete + 1).some((line) => line === "pgrep -u 12001"));
});

for (const [label, options] of [
  ["runner process", { runnerStatus: 0 }],
  ["gateway process", { gatewayStatus: 0 }],
  ["runner pgrep error", { runnerStatus: 2 }],
  ["gateway pgrep error", { gatewayStatus: 2 }],
  ["ps error with apparently idle output", { psStatus: 2 }],
  ["awk error", { awkStatus: 2 }],
  ["subordinate process", { processUids: "0\n131072" }],
  ["malformed process UID", { processUids: "0\nnot-a-uid" }],
  ["workspace", { workspace: "/var/tmp/api-migrator-preview.fixture" }],
  ["find error with empty output", { findStatus: 2 }],
  ["find error with partial output", { findStatus: 2, workspace: "/var/tmp/api-migrator-preview.fixture" }],
  ["nft inventory error", { nftStatus: 2 }],
  ["malformed nft inventory", { malformedNft: true }],
  ["failed nft inventory interpretation", { jqStatus: 2 }],
  ["unknown nft record", { nftSnapshot: '{"nftables":[{"unknown":{}}]}' }],
  ["nft table with non-string family", { nftSnapshot: '{"nftables":[{"table":{"family":[],"name":"other"}}]}' }],
  ["nft table with non-string name", { nftSnapshot: '{"nftables":[{"table":{"family":"inet","name":3}}]}' }],
  ["multiple nft JSON documents", { nftSnapshot: '{"nftables":[]}\n{"nftables":[]}' }],
]) {
  test(`ExecStopPost retains containment on ${label}`, () => retained(execute(boundary, options)));
}

for (const [label, nftSnapshot] of [
  ["empty inventory", '{"nftables":[]}'],
  ["unrelated table metadata", '{"nftables":[{"metainfo":{"version":"1.0.0","json_schema_version":1}},{"table":{"family":"ip","name":"unrelated table","handle":5,"flags":[]}}]}'],
]) {
  test(`ExecStopPost accepts observed job-table absence with ${label}`, () => {
    const result = execute(boundary, { nftSnapshot });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(deletions(result), []);
  });
}

test("ExecStopPost retains gateway containment after a failed removal observation", () => {
  const result = execute(boundary, { failAfterDelete: true });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(deletions(result), [`nft delete table inet ${LEGACY}`]);
});

test("ExecStopPost refuses failed deletion before removing gateway containment", () => {
  const result = execute(boundary, { deleteStatus: 2 });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(deletions(result), [`nft delete table inet ${LEGACY}`]);
});

function wrapperFunction(name) {
  const start = WRAPPER.indexOf(`\n${name}() {\n`) + 1;
  const end = WRAPPER.indexOf("\n}\n", start);
  assert(start > 0 && end !== -1);
  return WRAPPER.slice(start, end + 3);
}

const wrapperFixtures = `
WATCHDOG_PID=
WORKSPACE=
WORKSPACE_MOUNTED=0
OUTPUT_CREATED=0
CLEANUP_COMPLETE=0
PREPARE_CONTAINER=prepare
INSTALL_CONTAINER=install
MIGRATE_CONTAINER=migrate
VERIFY_CONTAINER=verify
EVIDENCE_PATH=/unused/evidence
TABLE=unused_table
delete_nft_table() { record "delete_nft_table"; }
run_as_job() { record "podman $*"; return 2; }
event() { record "event $*"; }
sync() { record "sync $*"; }
`;

test("wrapper early cancellation leaves policy removal to ExecStopPost", () => {
  const result = execute(`${wrapperFixtures}\n${wrapperFunction("early_cleanup")}\nset +e\n(exit 143)\nearly_cleanup`);
  assert.equal(result.status, 143, result.stderr);
  assert(!result.calls.some((line) => line.includes("delete_nft_table") || line.startsWith("nft ")));
});

for (const status of [0, 143]) {
  test(`wrapper Podman failure retains policy and cannot complete teardown (incoming status ${status})`, () => {
    const result = execute(`${wrapperFixtures}\n${wrapperFunction("cleanup")}\nset +e\n(exit ${status})\ncleanup`);
    assert.equal(result.status, status || 1, result.stderr);
    assert(!result.calls.some((line) => line.includes("delete_nft_table") || line.startsWith("nft ")));
    assert(result.calls.includes("event nftables_policy_retained pending-sealed-exec-stop-post"));
    assert(result.calls.includes("event wrapper_failed raw-events-must-not-be-signed"));
    assert(!result.calls.some((line) => line.includes("wrapper_local_teardown_complete")));
  });
}

test("wrapper deadline watchdog only signals termination and retains containment", () => {
  const start = WRAPPER.indexOf("(\n  remaining_ms=$((RUN_DEADLINE_MS");
  const end = WRAPPER.indexOf("\n) &\nWATCHDOG_PID=$!", start);
  assert(start !== -1 && end !== -1);
  const body = WRAPPER.slice(start + 2, end);
  const result = execute(`
RUN_DEADLINE_MS=1000
MAIN_PID=4321
TABLE=unused_table
date() { printf '1000'; }
sleep() { record "sleep $*"; }
timeout() { record "timeout $*"; }
kill() { record "kill $*"; }
${body}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["kill -TERM 4321"]);
});
