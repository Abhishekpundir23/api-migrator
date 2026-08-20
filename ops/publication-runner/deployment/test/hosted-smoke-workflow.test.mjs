import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowUrl = new URL("../../../../.github/workflows/linux-l7-smoke.yml", import.meta.url);
const workflow = readFileSync(workflowUrl, "utf8");

const scenarios = [
  "success",
  "timeout",
  "sigkill",
  "wrong_sni",
  "absent_sni",
  "plaintext",
  "direct_bypass",
  "non_443",
  "non_npm",
  "offline_network",
  "gateway_stop",
  "uid_idle",
  "policy_removal",
  "cgroup_namespace_cleanup",
  "workspace_cleanup",
];

test("hosted smoke workflow has the exact non-authorizing trigger and permission boundary", () => {
  assert.match(workflow, /^name: Linux L7 hosted smoke$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /^  push:$/m);
  assert.match(workflow, /^  pull_request:$/m);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|id-token:|:\s*write\b|environment:|secrets\./);
  assert.doesNotMatch(workflow, /GH_APP_|GITHUB_TOKEN|RUNNER_ATTESTATION|SIGNING_KEY|OPERATOR_APPROVAL_SECRET/);
});

test("hosted smoke workflow pins the runner, tools, and every third-party action", () => {
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 3);
  assert.match(workflow, /^  NODE_VERSION: 22\.23\.2$/m);
  assert.match(workflow, /envoyproxy\/envoy:v1\.39\.0@sha256:f6e2f57b1bef8235083a2553b523508cf97d8991c893fd2aae3a94a6b21096a2/);
  assert.match(workflow, /^  ENVOY_BINARY_SHA256: 7af83300cd615004f8b8fe58954705014c92754c5b68a1edf0dba1f3e9cc9920$/m);
  assert.match(workflow, /ld-linux-x86-64\.so\.2/);
  const expectedLibraries = workflow.match(/expected_libraries=\$\(printf '%s\\n' \\\n(?<body>(?:            [A-Za-z0-9_.-]+ \\\n)+)/)?.groups?.body ?? "";
  assert.match(expectedLibraries, /ld-linux-x86-64\.so\.2/);

  const uses = [...workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+).*$/gm)].map((match) => match[1]);
  assert(uses.length >= 8);
  assert(uses.every((value) => /@[a-f0-9]{40}$/.test(value)), uses.join("\n"));
  assert(uses.includes("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"));
  assert(uses.includes("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"));
  assert(uses.includes("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"));
  assert(uses.includes("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"));
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /^\s+cache:/m);
});

test("hosted smoke workflow runs the exact isolated 15-scenario matrix", () => {
  assert.match(workflow, /^      fail-fast: false$/m);
  const matrixBlock = workflow.match(/      matrix:\n        scenario:\n(?<body>(?:          - [a-z0-9_]+\n)+)    steps:/);
  assert(matrixBlock?.groups?.body, "scenario matrix is missing");
  const observed = [...matrixBlock.groups.body.matchAll(/^          - ([a-z0-9_]+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(observed, scenarios);
  assert.equal(new Set(observed).size, 15);
  assert(!observed.includes("oom"));
  assert(!observed.includes("reboot"));
  assert.match(workflow, /needs: prepare-envoy/);
  assert.match(workflow, /^    if: always\(\)$/m);
  assert.match(workflow, /needs: smoke/);
  assert.match(workflow, /SMOKE_MATRIX_RESULT: \$\{\{ needs\.smoke\.result \}\}/);
  assert.match(workflow, /\[\[ "\$SMOKE_MATRIX_RESULT" == success \]\]/);
  assert.match(workflow, /if: steps\.aggregate_report\.outcome == 'success'/);
});

test("hosted smoke workflow sanitizes privileged execution and always audits cleanup", () => {
  assert.match(workflow, /sudo env -i/);
  assert.match(workflow, /API_MIGRATOR_HOSTED_ENVOY_PATH=/);
  for (const name of [
    "API_MIGRATOR_SMOKE_RUN_ID",
    "API_MIGRATOR_SMOKE_RUN_ATTEMPT",
    "API_MIGRATOR_SMOKE_SOURCE_REVISION",
    "API_MIGRATOR_SMOKE_REPOSITORY",
    "API_MIGRATOR_SMOKE_WORKFLOW_REF",
    "API_MIGRATOR_SMOKE_IMAGE_VERSION",
  ]) {
    assert.match(workflow, new RegExp(`${name}=`));
  }
  assert.match(workflow, /run-hosted-smoke\.mjs/);
  assert.match(workflow, /\$\{runtime_root\}\/deployment\/run-hosted-smoke\.mjs/);
  assert.match(workflow, /\$\{tool_root\}\/runtime\/deployment\/cleanup-hosted-smoke\.mjs/);
  assert.match(workflow, /forced-gateway-egress\.nft\.in/);
  assert.match(workflow, /sha256sum --check --strict "\$\{runtime_root\}\/SHA256SUMS"/);
  assert.match(workflow, /find "\$runtime_root" -xdev -type f ! -name SHA256SUMS/);
  assert.doesNotMatch(workflow, /tee "\$\{runtime_root\}\/SHA256SUMS"/);
  assert.match(workflow, /sudo install -o root -g root -m 0444/);
  assert.equal((workflow.match(/cleanup-hosted-smoke\.mjs/g) ?? []).length, 5);
  assert.equal((workflow.match(/PATH="\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/g) ?? []).length, 2);
  assert.match(workflow, /sudo install -d -o root -g root -m 0700 -- "\$scenario_output"/);
  assert.match(workflow, /--scenario "\$\{\{ matrix\.scenario \}\}" \\\n            --output-dir "\$\{\{ steps\.scenario-output\.outputs\.scenario_output \}\}" \\\n            --audit-only/);
  assert((workflow.match(/if: always\(\)/g) ?? []).length >= 5);
  assert.match(workflow, /file_count <= 64/);
  assert.match(workflow, /size <= 2097152/);
  assert.match(workflow, /total_bytes <= 8388608/);
  assert.equal((workflow.match(/steps\.bound_artifacts\.outcome == 'success'/g) ?? []).length, 2);
  assert.match(workflow, /id: provision_identities/);
  assert.match(workflow, /groupadd --gid "\$runner_uid"/);
  assert.match(workflow, /useradd --uid "\$gateway_uid"/);
  assert.match(workflow, /runner_name=api-migrator-smoke-runner/);
  assert.match(workflow, /gateway_name=api-migrator-smoke-gateway/);
  assert.match(workflow, /runner_uid=12001/);
  assert.match(workflow, /gateway_uid=12002/);
  assert.match(workflow, /\$\{runner_name\}:x:\$\{runner_uid\}:\$\{runner_uid\}::\/nonexistent:\/usr\/sbin\/nologin/);
  assert.match(workflow, /\$\{gateway_name\}:x:\$\{gateway_uid\}:\$\{gateway_uid\}::\/nonexistent:\/usr\/sbin\/nologin/);
  assert.match(workflow, /steps\.provision_identities\.outputs\.identities_created == 'true'/);
  assert.doesNotMatch(workflow, /! (?:getent|ps)\b/);
  assert.match(workflow, /if getent passwd "\$key"/);
  assert.match(workflow, /if ps -eo uid= \| awk/);
});

test("hosted smoke workflow uploads bounded reports and aggregates all scenario artifacts", () => {
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /include-hidden-files: false/);
  assert.match(workflow, /linux-l7-smoke-scenario-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.scenario \}\}/);
  assert.match(workflow, /path: \$\{\{ steps\.scenario-output\.outputs\.scenario_output \}\}\/scenario-report\.json/);
  assert.match(workflow, /linux-l7-smoke-diagnostics-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.scenario \}\}/);
  assert.match(workflow, /path: \$\{\{ steps\.scenario-output\.outputs\.artifact_root \}\}/);
  assert.match(workflow, /pattern: linux-l7-smoke-scenario-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\*/);
  assert.match(workflow, /merge-multiple: false/);
  assert.match(workflow, /aggregate-hosted-smoke\.mjs/);
  assert.match(workflow, /--input-dir "\$input_root"/);
  assert.match(workflow, /--output "\$\{output_root\}\/aggregate-report\.json"/);
});

test("hosted smoke workflow cannot activate production or use privileged product credentials", () => {
  assert.doesNotMatch(workflow, /npm ci|run-credential-free-preview|observe-runner\.mjs|--live/);
  assert.doesNotMatch(workflow, /owner:sign|signingRequest|eligibleForExternalSigning|externalSigningEligible:\s*true/);
  assert.doesNotMatch(workflow, /verifiedRunnerCapability|runnerCapability|prepare-publication|publishExternal/);
});
