import { constants, closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  PUBLICATION_RUNNER_COMMAND_SCOPE_DIGEST,
  assertPublicationRunnerPlanCurrent,
  canonicalJson,
  parseCanonicalJson,
  validatePublicationRunnerPlan,
  type PublicationRunnerPlanRecord,
} from "@api-migrator/app/runner-internal";
import { parseManifest, type Manifest } from "@api-migrator/engine";
import { parseSourceBundle, type ParsedSourceBundle } from "./source-bundle.js";
import { sha256 } from "./filesystem.js";

const MAX_PLAN_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 262_144;

export interface ValidatedRunnerInputs {
  plan: PublicationRunnerPlanRecord;
  source: ParsedSourceBundle;
  manifest: Manifest;
  manifestJson: string;
}

export function loadPlan(planPath: string, now = Date.now()): PublicationRunnerPlanRecord {
  const bytes = readFileSync(planPath);
  const value = parseCanonicalJson(bytes, MAX_PLAN_BYTES, "publication runner plan");
  const plan = assertPublicationRunnerPlanCurrent(validatePublicationRunnerPlan(value), now);
  if (plan.canonicalJson !== bytes.toString("utf8")) {
    throw new Error("Publication runner plan bytes are not canonical");
  }
  if (plan.plan.inputs.commandScopeDigest !== PUBLICATION_RUNNER_COMMAND_SCOPE_DIGEST) {
    throw new Error("Publication runner plan command scope is unsupported");
  }
  return plan;
}

export function loadRunnerInputs(
  planPath: string,
  sourcePath: string,
  now = Date.now()
): ValidatedRunnerInputs {
  const plan = loadPlan(planPath, now);
  const bytes = readFileSync(sourcePath);
  const source = parseSourceBundle(bytes);
  if (source.digest !== plan.plan.inputs.sourceArchiveDigest) {
    throw new Error("Source bundle digest does not match the runner plan");
  }
  if (
    canonicalJson(source.header.repository) !== canonicalJson(plan.plan.subject.repository)
    || source.header.base.branch !== plan.plan.subject.base.branch
    || source.header.base.sha !== plan.plan.subject.base.sha
  ) {
    throw new Error("Source bundle repository or base identity does not match the runner plan");
  }
  if (
    source.header.manifest.digest !== plan.plan.inputs.manifestDigest
    || sha256(source.header.manifest.canonicalJson) !== plan.plan.inputs.manifestDigest
  ) {
    throw new Error("Source bundle manifest digest does not match the runner plan");
  }
  const { manifest, canonical } = parseCanonicalManifest(source.header.manifest.canonicalJson);
  return { plan, source, manifest, manifestJson: canonical };
}

export function persistDependencyManifest(root: string, manifestJson: string): void {
  const bytes = Buffer.from(manifestJson, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("Runner manifest exceeds its byte limit");
  }
  const descriptor = openSync(
    join(root, "manifest.json"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function loadDependencyManifest(
  root: string,
  plan: PublicationRunnerPlanRecord
): { manifest: Manifest; canonical: string } {
  const bytes = readFileSync(join(root, "manifest.json"));
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("Dependency manifest is missing or exceeds its byte limit");
  }
  const parsed = parseCanonicalManifest(bytes.toString("utf8"));
  if (sha256(parsed.canonical) !== plan.plan.inputs.manifestDigest) {
    throw new Error("Dependency manifest does not match the runner plan");
  }
  return parsed;
}

function parseCanonicalManifest(value: string): { manifest: Manifest; canonical: string } {
  const parsed = parseCanonicalJson(value, MAX_MANIFEST_BYTES, "migration manifest");
  const manifest = parseManifest(parsed);
  const canonical = canonicalJson(manifest);
  if (canonical !== value) {
    throw new Error("Migration manifest is not the exact canonical parsed manifest");
  }
  if (manifest.transformSet !== "inngest-v3-to-v4") {
    throw new Error("Runner v1 supports only the Inngest v3 to v4 transform set");
  }
  return { manifest, canonical };
}
