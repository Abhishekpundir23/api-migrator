import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicationRunnerPlan,
  type PublicationRunnerAttestation,
  type RunnerAttestationTrust,
} from "../../src/publication-runner.js";
import {
  createSourceBundle,
  parseSourceBundle,
  type SourceBundleRecord,
} from "../../src/runner-source-bundle.js";
import type { RunnerEvidenceContext } from "../../src/runner-evidence-contract.js";
import {
  publicationRunnerAttestation,
  publicationRunnerPlanInput,
  publicationRunnerReviewedOutput,
  publicationRunnerTrustPair,
  signedPublicationRunnerEnvelope,
} from "./publication-runner-fixture.js";

const MANIFEST_JSON = '{"name":"Runner evidence fixture","provider":"inngest"}';

function git(path: string, args: string[], createdAt: number): string {
  const date = new Date(createdAt).toISOString();
  return execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd: path,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "Runner Evidence Test",
      GIT_AUTHOR_EMAIL: "runner-evidence@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "Runner Evidence Test",
      GIT_COMMITTER_EMAIL: "runner-evidence@example.invalid",
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  }).trim();
}

export function runnerEvidenceFixture(now: number): {
  context: RunnerEvidenceContext;
  bundle: SourceBundleRecord;
  trust: RunnerAttestationTrust;
  payload: PublicationRunnerAttestation;
  envelope: string;
  signPayload(payload: PublicationRunnerAttestation): string;
  close(): void;
} {
  const createdAt = now - 105_000;
  const path = mkdtempSync(join(tmpdir(), "api-migrator-runner-evidence-test-"));
  try {
    git(path, ["init", "--initial-branch=main"], createdAt);
    writeFileSync(join(path, "index.ts"), "export const fixture = 1;\n");
    git(path, ["add", "index.ts"], createdAt);
    git(path, ["commit", "-m", "runner evidence fixture"], createdAt);
    const baseSha = git(path, ["rev-parse", "HEAD"], createdAt);
    const treeSha = git(path, ["rev-parse", "HEAD^{tree}"], createdAt);
    const repository = {
      slug: "fixture-org/fixture-repo",
      id: 1_234_567,
      ownerId: 7_654_321,
    };
    const bundle = createSourceBundle({
      checkoutPath: path,
      repository,
      base: { branch: "main", sha: baseSha, treeSha },
      manifestJson: MANIFEST_JSON,
    });
    const parsed = parseSourceBundle(bundle.bytes);
    const planInput = publicationRunnerPlanInput(createdAt);
    planInput.repository = structuredClone(repository);
    planInput.base = { branch: parsed.header.base.branch, sha: parsed.header.base.sha };
    planInput.sourceArchiveDigest = parsed.digest;
    planInput.manifestDigest = parsed.header.manifest.digest;
    planInput.expiresAt = createdAt + 900_000;
    const plan = createPublicationRunnerPlan(planInput);
    const reviewedOutput = publicationRunnerReviewedOutput();
    const { privateKey, trust } = publicationRunnerTrustPair(createdAt);
    const payload = publicationRunnerAttestation(plan, createdAt, reviewedOutput);
    const signPayload = (value: PublicationRunnerAttestation) =>
      signedPublicationRunnerEnvelope(value, privateKey, trust.keyId);
    const context: RunnerEvidenceContext = {
      campaignId: "campaign_fixture",
      runId: "run_fixture",
      plan,
      source: {
        repository: structuredClone(parsed.header.repository),
        base: {
          branch: parsed.header.base.branch,
          sha: parsed.header.base.sha,
          treeSha: parsed.header.base.treeSha,
        },
        manifestDigest: parsed.header.manifest.digest,
        sourceArchiveDigest: parsed.digest,
      },
      reviewedOutput,
      previewCompletedAt: now - 500,
    };
    return {
      context,
      bundle,
      trust,
      payload,
      envelope: signPayload(payload),
      signPayload,
      close: () => rmSync(path, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}
