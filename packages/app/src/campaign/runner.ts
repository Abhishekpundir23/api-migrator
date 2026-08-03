/** DB-backed, bounded campaign runner with preview-first publication. */

import {
  createRun,
  updateRun,
  upsertRepo,
  getCampaign,
  type MigrationRunStatus,
} from "@api-migrator/db";
import { Manifest, type MigrationReport } from "@api-migrator/engine";
import { migrateRepo, type MigrateRepoResult } from "../github.js";
import {
  PublicationAttemptError,
  type PublicationOutcome,
  type PublicationRequest,
} from "../publication.js";
import { parseRepositorySlug, stableStringify, validateBranchName } from "../repository.js";
import { safeErrorMessage } from "../security.js";

export interface RunCampaignInput {
  campaignId: string;
  repoSlugs: string[];
  /** Exact content-addressed branch from preview when supplied. */
  branch?: string;
  concurrency?: number;
  /** Omitted means preview. */
  publication?: PublicationRequest;
}

export interface CampaignRepoResult {
  slug: string;
  status: MigrationRunStatus;
  prUrl: string | null;
  preflightId?: string;
  report?: MigrationReport;
  publication?: PublicationOutcome;
  error?: string;
}

export interface CampaignRunSummary {
  campaignId: string;
  total: number;
  results: CampaignRepoResult[];
}

export async function runCampaign(input: RunCampaignInput): Promise<CampaignRunSummary> {
  const campaign = getCampaign(input.campaignId);
  if (!campaign) throw new Error(`campaign ${input.campaignId} not found`);
  assertCampaignActive(campaign.status, input.campaignId);
  const manifest = parseStoredManifest(campaign.manifest);
  // Bind the exact validated/upgraded manifest used by the engine. Legacy
  // campaigns and newly stored campaigns therefore share one authorization
  // digest and cannot diverge between console, preflight, and owner receipt.
  const manifestJson = stableStringify(manifest);
  const branchOverride = input.branch ? validateBranchName(input.branch) : undefined;
  const repoSlugs = input.repoSlugs.map((slug) => parseRepositorySlug(slug).slug);
  if (new Set(repoSlugs).size !== repoSlugs.length) {
    throw new Error("Campaign repository list contains duplicates");
  }

  const results: CampaignRepoResult[] = new Array(repoSlugs.length);
  const concurrency = Math.min(5, Math.max(1, input.concurrency ?? 2));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= repoSlugs.length) return;
      const slug = repoSlugs[index]!;
      const repo = upsertRepo({ slug });
      const run = createRun({
        campaignId: input.campaignId,
        repoId: repo.id,
        branch: branchOverride ?? "codex/api-migrator/pending",
      });
      try {
        const result: MigrateRepoResult = await migrateRepo({
          slug,
          manifest,
          manifestJson,
          branch: branchOverride,
          publication: input.publication,
        });
        const outcomeStatus = result.publication.status;
        const status = outcomeStatus as MigrationRunStatus;
        const blockerError =
          outcomeStatus === "blocked"
            ? result.publication.blockers.map((blocker) => blocker.message).join("; ")
            : undefined;
        upsertRepo({ slug, defaultBranch: result.publication.baseBranch });
        updateRun(run.id, {
          status,
          prUrl: result.prUrl,
          summary: result.report.summary,
          report: result.report,
          error: blockerError,
          publicationMode: result.publication.mode,
          preflightId: result.preflightId,
          artifactDigest: result.publication.artifactDigest,
          baseSha: result.publication.baseSha,
          baseBranch: result.publication.baseBranch,
          headSha: result.publication.headSha ?? null,
          publicationBlockers: result.publication.blockers,
          approvedBy: result.publication.approvedBy ?? null,
          overrideUnsafe: result.publication.overridden,
          overrideReason: null,
          branch: result.publication.branch,
        });
        results[index] = {
          slug,
          status,
          prUrl: result.prUrl,
          preflightId: result.preflightId,
          report: result.report,
          publication: result.publication,
          ...(blockerError ? { error: blockerError } : {}),
        };
      } catch (error) {
        const message = persistFailedRun(run.id, error);
        const prUrl = error instanceof PublicationAttemptError ? error.audit.prUrl ?? null : null;
        results[index] = { slug, status: "failed", prUrl, error: message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, repoSlugs.length) }, worker));
  return { campaignId: input.campaignId, total: repoSlugs.length, results };
}

/** Persist a handled failure, including exact branch state when publication had already mutated GitHub. */
export function persistFailedRun(runId: string, error: unknown): string {
  const patch = buildFailedRunPatch(error);
  updateRun(runId, patch);
  return patch.error;
}

/** Convert only trusted structured publication state into durable DB fields. */
export function buildFailedRunPatch(error: unknown) {
  const message = safeErrorMessage(error);
  if (!(error instanceof PublicationAttemptError)) {
    return { status: "failed" as const, error: message };
  }
  const audit = error.audit;
  return {
    status: "failed" as const,
    prUrl: audit.prUrl ?? null,
    summary: audit.report.summary,
    report: audit.report,
    error: message,
    publicationMode: audit.publicationMode,
    preflightId: audit.preflightId,
    artifactDigest: audit.artifactDigest,
    baseSha: audit.baseSha,
    baseBranch: audit.baseBranch,
    headSha: audit.headSha,
    publicationBlockers: audit.publicationBlockers,
    approvedBy: audit.approvedBy,
    overrideUnsafe: audit.overrideUnsafe,
    overrideReason: null,
    branch: audit.branch,
  };
}

export function assertCampaignActive(status: string, campaignId = "campaign"): void {
  if (status !== "active") {
    throw new Error(`campaign ${campaignId} is ${status}; only active campaigns can run`);
  }
}

export function parseStoredManifest(serialized: string): Manifest {
  try {
    const stored: unknown = JSON.parse(serialized);
    // Campaigns created before the audited runtime policy existed are upgraded
    // only when they are otherwise identifiable as this exact Inngest
    // migration. Explicit, null, or malformed runtime values still fail closed.
    const candidate = isLegacyInngestManifest(stored)
      ? {
          ...stored,
          runtime: AUDITED_INNGEST_RUNTIME_POLICY,
        }
      : stored;
    return Manifest.parse(candidate);
  } catch (error) {
    throw new Error(`Campaign manifest is invalid: ${safeErrorMessage(error)}`);
  }
}

function isLegacyInngestManifest(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const packagePolicy = "package" in value ? value.package : null;
  return "provider" in value
    && value.provider === "inngest"
    && "transformSet" in value
    && value.transformSet === "inngest-v3-to-v4"
    && typeof packagePolicy === "object"
    && packagePolicy !== null
    && !Array.isArray(packagePolicy)
    && "name" in packagePolicy
    && packagePolicy.name === "inngest"
    && !("runtime" in value);
}

const AUDITED_INNGEST_RUNTIME_POLICY = {
  node: {
    minimumMajor: 20,
    profile: "node22-bookworm-slim-2026-07",
    packageJson: "package.json",
    dockerfile: "Dockerfile",
  },
} as const;
