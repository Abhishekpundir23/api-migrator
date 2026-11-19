/** Runtime-validated migration campaign manifests. */

import { z } from "zod";

export const TRANSFORM_ALLOWLIST = {
  "inngest-v3-to-v4": [
    "T1", "T2", "T3", "T4", "T5",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10",
    "F11", "F12", "F13", "F14",
  ],
  "knock-v0-to-v1": [
    "K1", "K2", "K3", "K4", "K5",
    "KF1", "KF2", "KF3", "KF4", "KF5", "KF6",
  ],
} as const;

export type TransformSet = keyof typeof TRANSFORM_ALLOWLIST;

/** Identifier of a transform or review detector. */
export const TransformId = z.string().trim().min(1);

/** A package version floor that must be satisfied for the migration to verify. */
export const PeerFloor = z.strictObject({
  name: z.string().trim().min(1),
  range: z.string().trim().min(1),
});

/**
 * A deliberately narrow, audited deployment profile. Provider manifests pick
 * a trusted profile name; they cannot supply an arbitrary image or path.
 */
export const NodeRuntimePolicy = z.strictObject({
  minimumMajor: z.literal(20),
  profile: z.literal("node22-bookworm-slim-2026-07"),
  packageJson: z.literal("package.json"),
  dockerfile: z.literal("Dockerfile"),
});

export const RuntimePolicy = z.strictObject({
  node: NodeRuntimePolicy,
});

/** Operator-declared hosting model; not inferred from the Node runtime image. */
export const DeploymentPolicy = z.strictObject({
  kind: z.enum(["long-running", "serverless"]),
});

const ManifestBase = z.strictObject({
  name: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  transformSet: z.enum(["inngest-v3-to-v4", "knock-v0-to-v1"]),
  package: z.strictObject({
    name: z.string().trim().min(1),
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
  }),
  peerFloors: z.array(PeerFloor).default([]),
  runtime: RuntimePolicy.optional(),
  deployment: DeploymentPolicy.optional(),
  /** Omit for the complete set. Inngest F12 remains mandatory even with a subset. */
  transforms: z.array(TransformId).optional(),
  notes: z.string().optional(),
});

/**
 * Provider-authored manifest schema. Unknown fields and unknown transform ids
 * are rejected before the repository is copied, installed, or modified.
 */
export const Manifest = ManifestBase.superRefine((manifest, ctx) => {
  const allowed = new Set<string>(TRANSFORM_ALLOWLIST[manifest.transformSet]);
  for (const [index, id] of (manifest.transforms ?? []).entries()) {
    if (!allowed.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: ["transforms", index],
        message: `Unknown transform id ${JSON.stringify(id)} for ${manifest.transformSet}`,
      });
    }
  }
  const duplicatePeers = manifest.peerFloors
    .map((peer) => peer.name)
    .filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicatePeers.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["peerFloors"],
      message: `Duplicate peer floor(s): ${[...new Set(duplicatePeers)].join(", ")}`,
    });
  }
  if (manifest.transformSet === "inngest-v3-to-v4" && !manifest.runtime) {
    ctx.addIssue({
      code: "custom",
      path: ["runtime"],
      message: "Inngest v4 migrations require the audited Node 20/22 runtime policy",
    });
  }
});

export type Manifest = z.infer<typeof Manifest>;
export type LoadedManifest = Manifest;
export type NodeRuntimePolicy = z.infer<typeof NodeRuntimePolicy>;
export type RuntimePolicy = z.infer<typeof RuntimePolicy>;
export type DeploymentPolicy = z.infer<typeof DeploymentPolicy>;

export function parseManifest(input: unknown): Manifest {
  return Manifest.parse(input);
}

export function enabledTransforms(manifest: Manifest): ReadonlySet<string> {
  return new Set(manifest.transforms ?? TRANSFORM_ALLOWLIST[manifest.transformSet]);
}
