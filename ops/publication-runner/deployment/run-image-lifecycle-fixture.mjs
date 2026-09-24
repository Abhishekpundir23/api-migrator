#!/usr/bin/env node
import { mkdirSync, realpathSync, lstatSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync, chownSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSanitizedRunnerEnvironment, parseHostedSmokeEnvironment, nftCounterDelta } from "./run-hosted-smoke.mjs";
import { createFixturePhaseOperations, prepareFixtureWorkspace, createFixturePlan } from "../image/fixture-phases.mjs";
import { validatePublicationRunnerPlan } from "../../../packages/app/dist/runner-internal.js";
import * as host from "./run-hosted-smoke.mjs";
import { canonicalJson, renderGatewayDeployment } from "../gateway/gateway-contract.mjs";
import { deriveFixtureResources, fixtureOwnership } from "./fixture-ownership.mjs";
import { createFixtureNative, executeNativeFixturePhase, assertFixtureDockerDaemon, fixtureContainerInventory, cleanupNativeFixture } from "./fixture-native.mjs";
import { runFixtureLifecycle } from "./fixture-lifecycle.mjs";
import { annotateFixtureFailure, assertFixtureDiagnosticStage, atFixtureStage, formatFixtureFailure, markFixtureCleanupFailure } from "./fixture-diagnostics.mjs";
export { formatFixtureFailure } from "./fixture-diagnostics.mjs";

const USAGE = "usage: run-image-lifecycle-fixture.mjs --image sha256:DIGEST --output-dir /tmp/api-migrator-fixture-results/NAME [--scenario install_failure]";
const CLEANUP_RESERVE_MS = 30000;
const OPERATION_STAGES = ["installPolicy", "prepare", "startGateway", "probeOnline", "install", "stopGateway", "assertOffline", "migrate", "verify"];
const safeInteger = (value) => Number.isSafeInteger(value) ? value : null;

export async function resolveImageFixtureOrigin(options = {}) {
  let diagnostic;
  try {
    return await host.resolveHostedNpmOrigin({ ...options, requiredMinimumTtlSeconds: 120,
      writeDiagnostics(bytes) {
        diagnostic = JSON.parse(bytes);
        options.writeDiagnostics?.(bytes);
      } });
  } catch {
    const failure = new Error("fixture DNS admission failed");
    const outcomes = new Set(["ttl_floor_exhausted", "resolver_timeout", "resolver_error", "missing_or_excessive_answer", "invalid_answer"]);
    const reason = outcomes.has(diagnostic?.outcome) ? diagnostic.outcome : "diagnostic_or_internal_failure";
    throw annotateFixtureFailure(failure, { stage: "setup.dns", category: "dns_admission", reason,
      attempts: diagnostic?.attempts, elapsedMs: diagnostic?.elapsedMs, requiredMinimumTtlSeconds: 120 });
  }
}
export function parseImageLifecycleFixtureCli(argv) {
  if (!Array.isArray(argv) || ![4, 6].includes(argv.length) || argv[0] !== "--image" || argv[2] !== "--output-dir" ||
      !/^sha256:[a-f0-9]{64}$/.test(argv[1]) || !/^\/tmp\/api-migrator-fixture-results\/[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(argv[3]) ||
      (argv.length === 6 && (argv[4] !== "--scenario" || !["success", "install_failure"].includes(argv[5])))) throw new Error(USAGE);
  return Object.freeze({ image: argv[1], outputDir: argv[3], scenario: argv[5] ?? "success" });
}

export function validateFixtureEnvironment(env) {
  assertSanitizedRunnerEnvironment(env);
  return parseHostedSmokeEnvironment(env);
}

export function claimFixtureOutput(path) {
  if (resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) throw new Error("fixture output parent substituted");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0) {
    throw new Error("fixture output parent is writable or substituted");
  }
  mkdirSync(path, { mode: 0o700 }); // Exclusive creation is the repeat-run gate.
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("fixture output directory substituted");
  }
}

export function assertFixtureFresh(record, dnsExpiry, now, timeoutMs, stage = "unspecified") {
  assertFixtureDiagnosticStage(stage);
  const job = record?.plan?.job;
  if (![job?.createdAt, job?.expiresAt, dnsExpiry, now, timeoutMs].every(Number.isSafeInteger) ||
      timeoutMs < 1 || now < job.createdAt || now + timeoutMs + CLEANUP_RESERVE_MS >= Math.min(job.expiresAt, dnsExpiry)) {
    const difference = (a, b) => Number.isSafeInteger(a) && Number.isSafeInteger(b) ? safeInteger(a - b) : null;
    const diagnostic = `fixture plan or DNS expired or lacks command lifetime (stage=${stage}, ` +
      `planAgeMs=${difference(now, job?.createdAt)}, planRemainingMs=${difference(job?.expiresAt, now)}, ` +
      `dnsRemainingMs=${difference(dnsExpiry, now)}, commandBudgetMs=${safeInteger(timeoutMs)}, cleanupReserveMs=${CLEANUP_RESERVE_MS})`;
    const error = new Error(diagnostic);
    throw annotateFixtureFailure(error, { stage, category: "freshness", planAgeMs: difference(now, job?.createdAt),
      planRemainingMs: difference(job?.expiresAt, now), dnsRemainingMs: difference(dnsExpiry, now),
      commandBudgetMs: safeInteger(timeoutMs), cleanupReserveMs: CLEANUP_RESERVE_MS });
  }
  return timeoutMs;
}

export function proveForcedFixtureRoute(before, after) {
  const delta = (name) => nftCounterDelta(before, after, name);
  const proof = { redirect: delta("redirect"), loopback: delta("runnerV4") + delta("runnerV6"),
    upstream: delta("gatewayV4") + delta("gatewayV6"),
    downstream: delta("gatewayDownstreamV4") + delta("gatewayDownstreamV6"), rejected: delta("gatewayReject") };
  if (proof.redirect < 1 || proof.loopback < 1 || proof.upstream < 1 || proof.downstream < 1 || proof.rejected !== 0) {
    throw new Error("fixture forced route lacks correlated redirect, loopback, upstream and downstream proof");
  }
  return Object.freeze(proof);
}

export class ExpectedInstallFailure extends Error {}

export function createImageFixtureOperations({ plan, paths, image, native, execute, evidence, scenario, now = Date.now }) {
  validatePublicationRunnerPlan(plan.plan);
  if (plan.plan.imageDigest !== image || !["success", "install_failure"].includes(scenario)) throw new Error("fixture image or scenario substituted");
  const origin = plan.plan.egress.install.destinations[0];
  const phaseTimeout = 45000;
  const phases = createFixturePhaseOperations({ image, paths, plan, addresses: origin.addresses,
    installNetwork: "host", uid: 12001, gid: 12001, timeoutMs: phaseTimeout,
    execute: async (request) => {
      assertFixtureFresh(plan, origin.resolutionExpiresAt, now(), request.timeoutMs, `${request.phase}.launch`);
      const output = await atFixtureStage(`${request.phase}.execute`, "unexpected", () => execute(request), { commandBudgetMs: request.timeoutMs });
      assertFixtureFresh(plan, origin.resolutionExpiresAt, now(), 1, `${request.phase}.complete`);
      return output;
    } });
  let stage = 0, prepared, installed, migrated, installProof;
  const order = (expected) => {
    if (stage !== expected) throw new Error("fixture operation order rejected");
    assertFixtureFresh(plan, origin.resolutionExpiresAt, now(), 15000, OPERATION_STAGES[expected]);
  };
  const probe = (scenario) => {
    assertFixtureFresh(plan, origin.resolutionExpiresAt, now(), 15000, `probe.${scenario}`);
    atFixtureStage(`probe.${scenario}`, "host_operation", () => native.probe(scenario));
  };
  const operations = {
    async installPolicy() { order(0); await native.installPolicy(); stage = 1; },
    async prepare() { order(1); prepared = await atFixtureStage("prepare.validate", "protocol", () => phases.prepare()); stage = 2; },
    async startGateway() {
      order(2);
      const ready = await native.startGateway();
      if (ready?.uid !== 12002 || JSON.stringify(ready.listeners) !== '["127.0.0.1","::1"]') throw new Error("fixture gateway UID/listener evidence absent");
      stage = 3;
    },
    async probeOnline() {
      order(3);
      for (const name of ["wrong_sni", "absent_sni", "wrong_sni_ipv6", "absent_sni_ipv6", "non_443", "non_npm", "correct_sni", "correct_sni_ipv6"]) {
        const before = native.counters(); probe(name); const after = native.counters();
        if (name.includes("wrong_sni") || name.includes("absent_sni")) {
          const family = name.endsWith("ipv6") ? "runnerV6" : "runnerV4";
          if (nftCounterDelta(before, after, family) < 1 || nftCounterDelta(before, after, "gatewayV4") + nftCounterDelta(before, after, "gatewayV6") !== 0) {
            throw new Error("fixture SNI denial lacks correlated listener-only counters");
          }
        }
        if (["non_443", "non_npm"].includes(name) && nftCounterDelta(before, after, name === "non_443" ? "runnerReject" : "gatewayReject") < 1) {
          throw new Error("fixture denial lacks reject counter");
        }
      }
      const before = native.counters(); probe("direct_bypass");
      atFixtureStage("probeOnline", "evidence", () => evidence.write("direct-forced-route", JSON.stringify(proveForcedFixtureRoute(before, native.counters()))));
      stage = 4;
    },
    async install() {
      order(4);
      const before = native.counters();
      if (scenario === "install_failure") {
        try { await atFixtureStage("install.validate", "protocol", () => phases.install({ preparedStateDigest: `sha256:${"0".repeat(64)}` })); }
        catch (error) {
          // Only a real nonzero install subprocess is the injected outcome;
          // expiry/UID/evidence errors must not be converted to expected failure.
          if (error?.code !== "FIXTURE_INSTALL_PROTOCOL_REJECTED") throw error;
          throw new ExpectedInstallFailure("fixed install protocol rejection observed");
        }
        throw new Error("fixed install failure unexpectedly succeeded");
      }
      installed = await atFixtureStage("install.validate", "protocol", () => phases.install(prepared));
      installProof = proveForcedFixtureRoute(before, native.counters());
      atFixtureStage("install.evidence", "evidence", () => evidence.write("install-forced-route", JSON.stringify(installProof)));
      stage = 5;
    },
    async stopGateway() { order(5); await native.stopGateway(); stage = 6; },
    async assertOffline() {
      order(6);
      if (!native.idle() || !native.listenerAbsent()) throw new Error("fixture UID/cgroup idle or listener absence unproven");
      const before = native.counters(); probe("offline_network"); const after = native.counters();
      if (nftCounterDelta(before, after, "redirect") < 1 ||
          nftCounterDelta(before, after, "runnerV4") + nftCounterDelta(before, after, "runnerV6") < 1 ||
          nftCounterDelta(before, after, "gatewayV4") + nftCounterDelta(before, after, "gatewayV6") !== 0 ||
          nftCounterDelta(before, after, "gatewayDownstreamV4") + nftCounterDelta(before, after, "gatewayDownstreamV6") !== 0 || !native.idle()) {
        throw new Error("fixture offline closure proof incomplete");
      }
      atFixtureStage("assertOffline", "evidence", () => evidence.write("offline-closure", JSON.stringify({ idle: true, listenerAbsent: true, before, after })));
      stage = 7;
    },
    async migrate() { order(7); migrated = await atFixtureStage("migrate.validate", "protocol", () => phases.migrate(installed)); stage = 8; },
    async verify() { order(8); const result = await atFixtureStage("verify.validate", "protocol", () => phases.verify(migrated)); stage = 9; return { ...result, installProof }; },
    async cleanup() { return native.cleanup(); },
  };
  return Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name,
    () => atFixtureStage(name, name === "cleanup" ? "cleanup" : "host_operation", operation)]));
}

function writeOwnership(outputDir, resources) {
  const temporary = join(outputDir, "ownership.next");
  writeFileSync(temporary, canonicalJson(fixtureOwnership(resources)), { flag: "wx", mode: 0o600 });
  renameSync(temporary, join(outputDir, "ownership.json"));
}

function makeOwnedDirectory(path, mode) {
  const parentExisted = existsSync(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  if (!parentExisted) chmodSync(dirname(path), 0o755);
  const stat = lstatSync(dirname(path));
  if (stat.uid !== 0 || stat.gid !== 0 || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      realpathSync(dirname(path)) !== dirname(path)) throw new Error("fixture parent directory is not sealed");
  mkdirSync(path, { mode });
  chmodSync(path, mode);
}

function renderFixtureGateway(plan, resources, inventory) {
  const destination = plan.plan.egress.install.destinations[0];
  const deployment = renderGatewayDeployment({ schemaVersion: 1, profile: "static-envoy-sni-passthrough-v1",
    jobId: plan.plan.job.id,
    plan: { digest: plan.digest, createdAt: plan.plan.job.createdAt, expiresAt: plan.plan.job.expiresAt },
    egressPolicyDigest: plan.plan.egress.install.policyDigest, gatewayRuntimeDigest: inventory.tools.envoy.digest,
    runnerUid: 12001, gatewayUid: 12002, listener: { addresses: ["127.0.0.1", "::1"], port: 15443 },
    origin: { host: destination.host, port: destination.port, addresses: destination.addresses,
      resolutionEvidenceDigest: destination.resolutionEvidenceDigest, resolutionObservedAt: destination.resolutionObservedAt,
      resolutionExpiresAt: destination.resolutionExpiresAt } });
  if (deployment.nftablesTable !== resources.nftTable) throw new Error("fixture table differs from actual plan identity");
  const result = { deployment };
  for (const [key, name, bytes] of [["contractPath", "gateway-contract.json", deployment.canonicalJson],
    ["envoyConfigPath", "envoy-config.json", deployment.envoyConfigJson],
    ["nftablesPolicyPath", "gateway-policy.nft", deployment.nftablesPolicy]]) {
    result[key] = join(resources.runtimeRoot, name);
    writeFileSync(result[key], bytes, { flag: "wx", mode: 0o444 });
    chmodSync(result[key], 0o444);
  }
  return result;
}

export async function runImageLifecycleFixture(argv) {
  const context = { stage: "setup.cli", category: "protocol" };
  try { return await runImageLifecycleFixtureInternal(argv, context); }
  catch (error) { throw annotateFixtureFailure(error, context); }
}

async function runImageLifecycleFixtureInternal(argv, context) {
  const config = parseImageLifecycleFixtureCli(argv);
  context.stage = "setup.environment"; context.category = "identity";
  const environment = validateFixtureEnvironment(process.env);
  context.stage = "setup.platform";
  host.assertLinuxHostedRoot(); host.readOsRelease();
  context.stage = "setup.accounts";
  host.validateHostedSmokeAccounts(readFileSync("/etc/passwd", "utf8"), readFileSync("/etc/group", "utf8"));
  context.stage = "setup.tools";
  const inventory = host.buildToolInventory(environment.envoyPath), tools = inventory.paths;
  const docker = host.findTool(["/usr/bin/docker"], "Docker");
  context.stage = "setup.docker";
  const daemon = JSON.parse(host.runCommand(docker, ["--host=unix:///var/run/docker.sock", "info", "--format", "{{json .}}"], { timeoutMs: 10000 }).stdout);
  assertFixtureDockerDaemon(daemon);
  context.stage = "setup.context";
  const dockerContext = host.runCommand(docker, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeoutMs: 5000 }).stdout.trim();
  if (dockerContext !== "unix:///var/run/docker.sock") throw new Error("fixture Docker context is not the exact local daemon");
  context.stage = "setup.image";
  const image = host.runCommand(docker, ["image", "inspect", "--format", "{{.Id}}", config.image], { timeoutMs: 10000 }).stdout.trim();
  if (image !== config.image) throw new Error("fixture preloaded image digest substituted");
  context.stage = "setup.resources";
  let resources = deriveFixtureResources({ ...environment, ...config, image });
  if (existsSync(resources.runtimeRoot) || existsSync(resources.workspacePath) ||
      host.unitSnapshot(tools.systemctl, resources.gatewayUnit).values.LoadState !== "not-found" ||
      host.pidsForUid(12001).length || host.pidsForUid(12002).length ||
      !host.proveHostedListenerAbsence(host.listenerSnapshot(tools.ss, 15443))) throw new Error("fixture initial resource collision");
  context.stage = "setup.output";
  claimFixtureOutput(config.outputDir);
  context.stage = "setup.ownership";
  writeOwnership(config.outputDir, resources);
  let lifecycleOwnsCleanup = false;
  try {
    context.stage = "setup.workspace"; context.category = "host_operation";
    makeOwnedDirectory(resources.runtimeRoot, 0o755);
    makeOwnedDirectory(resources.workspacePath, 0o711);
    const evidenceDir = join(config.outputDir, "evidence"); mkdirSync(evidenceDir, { mode: 0o700 });
    const evidence = host.createEvidenceWriter(evidenceDir);
    // Root fixture construction/lockfile acquisition is explicitly outside the
    // measured restricted runner. Fresh DNS is acquired only after it finishes.
    const prepared = prepareFixtureWorkspace(resources.workspacePath);
    context.stage = "setup.dns";
    const resolution = await resolveImageFixtureOrigin({ writeDiagnostics: (bytes) => evidence.write("dns-diagnostics", bytes) });
    context.stage = "setup.plan"; context.category = "protocol";
    const now = Date.now();
    const window = host.hostedNpmPlanWindow({ minimumTtlSeconds: resolution.minimumTtlSeconds, resolutionObservedAt: resolution.observedAt, createdAt: now });
    const plan = createFixturePlan(prepared, { imageDigest: image, addresses: resolution.addresses, resolutionObservedAt: resolution.observedAt,
      ...window, now });
    resources = deriveFixtureResources({ ...resources, jobId: plan.plan.job.id, planDigest: plan.digest });
    context.stage = "setup.collision"; context.category = "identity";
    if (host.tableSnapshot(tools.nft, resources.nftTable, true).exists || fixtureContainerInventory(resources, docker).length) {
      // Do not adopt a collided table/container into the marker's authority.
      throw new Error("fixture plan resource collision");
    }
    context.stage = "setup.ownership";
    writeOwnership(config.outputDir, resources);
    context.stage = "setup.evidence"; context.category = "evidence";
    evidence.write("dns-window", canonicalJson({ ...resolution, ...window }));
    evidence.write("plan-identity", canonicalJson({ jobId: resources.jobId, planDigest: plan.digest, image, sourceDigest: prepared.bundle.digest }));
    context.stage = "setup.permissions"; context.category = "identity";
    for (const name of ["dependencies", "installation", "output", "result"]) {
      chownSync(prepared.paths[name], 12001, 12001); chmodSync(prepared.paths[name], 0o700);
    }
    for (const name of ["planPath", "sourcePath"]) { chownSync(prepared.paths[name], 0, 12001); chmodSync(prepared.paths[name], 0o440); }
    context.stage = "setup.gateway"; context.category = "protocol";
    const rendered = renderFixtureGateway(plan, resources, inventory);
    const native = createFixtureNative({ resources, rendered, tools, docker, evidence, outputDir: config.outputDir });
    const operations = createImageFixtureOperations({ plan, paths: prepared.paths, image, native, evidence, scenario: config.scenario,
      execute: (request) => executeNativeFixturePhase(request, { resources, docker, evidence }) });
    lifecycleOwnsCleanup = true;
    let result;
    try { result = await runFixtureLifecycle(operations); }
    catch (error) {
      if (!(error instanceof ExpectedInstallFailure) || config.scenario !== "install_failure") throw error;
      result = { phaseIntegration: "expected_install_protocol_rejection", cleanup: "complete",
        securityDrill: false, selfAttested: true, releaseEvidenceEligible: false, activationBlocked: true, externalSigningEligible: false };
    }
    context.stage = "setup.report"; context.category = "evidence";
    const report = { schemaVersion: 1, kind: "api_migrator_joined_image_lifecycle_fixture", scenario: config.scenario,
      sourceRevision: environment.sourceRevision, sourceDigest: prepared.bundle.digest, planDigest: plan.digest,
      jobId: plan.plan.job.id, image, gatewayDigest: rendered.deployment.digest, cleanup: "complete", ...result };
    const bytes = canonicalJson(report);
    if (Buffer.byteLength(bytes) > 32768) throw new Error("fixture result exceeds bound");
    writeFileSync(join(config.outputDir, "fixture-report.json"), bytes, { mode: 0o600, flag: "wx" });
    return report;
  } catch (error) {
    error = annotateFixtureFailure(error, context);
    if (!lifecycleOwnsCleanup) {
      // Read the last persisted authority, not a candidate plan that collided.
      try {
        const marker = JSON.parse(readFileSync(join(config.outputDir, "ownership.json"), "utf8"));
        await cleanupNativeFixture(deriveFixtureResources(marker), { tools, docker, outputDir: config.outputDir });
      }
      catch (cleanupError) {
        const failure = new AggregateError([error, annotateFixtureFailure(cleanupError, { stage: "cleanup", category: "cleanup" })], "fixture setup and cleanup failed");
        markFixtureCleanupFailure(failure);
        throw failure;
      }
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runImageLifecycleFixture(process.argv.slice(2)).then((result) => process.stdout.write(`${canonicalJson(result)}\n`),
    (error) => {
      // The fixture has no external source or credentials. Still print only a
      // bounded first diagnostic line, never raw subprocess output or stacks.
      const message = formatFixtureFailure(error);
      process.stderr.write(`image lifecycle fixture failed: ${message}\n`); process.exitCode = 1;
    });
}
