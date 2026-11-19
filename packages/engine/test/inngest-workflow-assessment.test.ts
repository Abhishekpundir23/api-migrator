import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { assessRepository } from "../src/assessment.js";
import { inngestWorkflowReviewEntries } from "../src/inngest-workflow-assessment.js";
import type { ReportEntry } from "../src/types.js";

const filename = ".github/workflows/private-preview.yml";
const client = 'import { Inngest } from "inngest"; export const inngest = new Inngest({ id: "private-app" });';

function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), "inngest-workflow-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function workflow(...statements: string[]) {
  return ["name: Deploy preview", "on: pull_request", "jobs:", "  deploy-preview:", "    steps:",
    "      - name: Wait for preview", "        run: |", ...statements.map(s => "          " + s)].join("\n");
}

const endpoint = 'INNGEST_URL="${{ steps.deploy.outputs.cloud_run_url }}/api/inngest"';
const poll = 'STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${INNGEST_URL}" 2>/dev/null || true)';
const check = 'if [ "${STATUS}" = "200" ]; then';
const putRegistration = 'curl --fail-with-body --retry 3 --retry-all-errors --retry-delay 5 -X PUT "${INNGEST_URL}"';

test("owner assessment reports the unsigned 200 readiness gate at its curl line, privately and read-only", t => {
  const root = directory(t);
  const source = workflow(endpoint, "for attempt in 1 2 3; do", poll, check, "  break", "fi", "done", putRegistration, "touch unexpected-execution-sentinel");
  put(root, filename, source);
  put(root, "client.ts", client);
  const local: ReportEntry[] = [];
  const result = assessRepository(root, "inngest-v3-to-v4", e => local.push(e));
  assert.deepEqual(result.findings.find(e => e.code === "F16"), { code: "F16", kind: "review", count: 1 });
  assert.equal(result.sourceFiles, 1);
  assert.equal(result.matchedFiles, 1);
  assert.equal(result.wouldChangeFiles, 0);
  const finding = local.find(e => e.code === "F16");
  assert.equal(finding?.file, filename);
  assert.equal(finding?.line, source.split("\n").findIndex(s => s.includes("STATUS=$(curl")) + 1);
  assert.match(finding!.message, /signed GET/);
  assert.doesNotMatch(JSON.stringify(result), /private|cloud_run_url|\.github|api\/inngest/);
  assert.equal(readFileSync(join(root, filename), "utf8"), source);
  assert.equal(existsSync(join(root,"unexpected-execution-sentinel")), false);
});

test("recognizes explicit GET, safe headers, line continuations, and same-step endpoint aliases", t => {
  const root = directory(t);
  put(root, filename, workflow('ORIGIN="https://preview.example.test"', 'API="${ORIGIN}/api/inngest"',
    'STATUS=$(curl --request GET --header "Accept: application/json" \\',
    '  --write-out="%{response_code}" --output /dev/null --url "${API}")', check, "  break", "fi",
    'until curl -fsS --url="$API"; do', "  sleep 1", "done"));
  assert.equal(inngestWorkflowReviewEntries(root).length, 2);
});

test("health readiness, registration, signed/unknown options, telemetry, and other endpoints stay quiet", t => {
  const root = directory(t);
  for (const [label, command] of Object.entries({
    health: poll.replace('"${INNGEST_URL}"','"https://preview.example.test/health"'),
    put: poll.replace("curl -s", "curl -XPUT -s"),
    post: poll.replace("curl -s","curl --data '{}' -s"),
    head: poll.replace("curl -s","curl -I -s"),
    signature: poll.replace("curl -s",'curl --header "X-Inngest-Signature: $SIG" -s'),
    laterSignature: poll.replace("2>/dev/null || true",'2>/dev/null -H"X-Inngest-Signature: $SIG" || true'),
    opaque: poll.replace("curl -s",'curl --config from-file -s'),
    token: poll.replace("curl -s",'curl -u "$USER:$PASSWORD" -s'),
    ignoredFailure: 'curl --fail --retry 2 "${INNGEST_URL}" || true',
    noGate: 'curl -s "${INNGEST_URL}"',
    localhost: poll.replace('"${INNGEST_URL}"','"http://localhost:8080/api/inngest"'),
    wrongPath: poll.replace('"${INNGEST_URL}"','"https://preview.example.test/api/inngest-status"'),
    commented: "# " + poll,
    shellText: "echo '" + poll + "'",
  })) {
    put(root, filename, workflow(endpoint, command, check, "  break", "fi", putRegistration));
    assert.deepEqual(inngestWorkflowReviewEntries(root), [], label);
  }
  put(root, filename, workflow(endpoint, poll, 'if [ "$OTHER_STATUS" = "200" ]; then', " true", "fi", putRegistration));
  assert.deepEqual(inngestWorkflowReviewEntries(root), []);
  put(root, filename, workflow(endpoint, "cat <<'EXAMPLE'", poll, check, "  break", "fi", "EXAMPLE"));
  assert.deepEqual(inngestWorkflowReviewEntries(root), []);
});

test("workflow-local evidence is restricted to literal jobs.steps.run and the selected SDK context", t => {
  const root = directory(t);
  put(root,"elsewhere/workflows/deploy.yml",workflow(endpoint,poll,check));
  put(root,".github/workflows/nested/deploy.yml",workflow(endpoint,poll,check));
  put(root,filename,workflow('echo "no probe"')+"\n    env:\n      DOCUMENTATION: |\n        run: |\n          "+poll+"\n          "+check+"\n");
  assert.deepEqual(inngestWorkflowReviewEntries(root),[]);
  put(root,filename,workflow(endpoint,poll,check));
  put(root,"unrelated.ts",'export const value = 2;');
  assert.equal(assessRepository(root,"inngest-v3-to-v4").findings.length,0);
  assert.equal(assessRepository(root,"knock-v0-to-v1").findings.some(f=>f.code==="F16"), false);
});

test("refuses symlinked workflow files and ancestor directories and fails oversized review atomically", t => {
  const external = directory(t);
  put(external,"x.yml",workflow(endpoint,poll,check));
  for (const level of [".github",".github/workflows",filename]) {
    const root=directory(t);
    put(root,"client.ts",client);
    mkdirSync(dirname(join(root,level)),{recursive:true});
    symlinkSync(level===filename?join(external,"x.yml"):external,join(root,level));
    const local: ReportEntry[]=[];
    assert.throws(()=>assessRepository(root,"inngest-v3-to-v4",e=>local.push(e)),/symlink/);
    assert.deepEqual(local,[]);
  }
  const root=directory(t);
  put(root,"client.ts",client);
  put(root,filename,workflow(endpoint,poll,check));
  put(root,".github/workflows/z.yaml","");
  truncateSync(join(root,".github/workflows/z.yaml"),1024*1024+1);
  const local: ReportEntry[]=[];
  assert.throws(()=>assessRepository(root,"inngest-v3-to-v4",e=>local.push(e)),/exceeds/);
  assert.deepEqual(local,[]);
});
