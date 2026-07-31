/**
 * Migration manifest — the declarative description of a migration campaign.
 *
 * A provider authors one manifest per breaking change (e.g. "Inngest v3->v4").
 * The engine reads it, finds affected repos, and applies the listed transforms.
 * This is what makes the engine provider-agnostic: a new SDK migration is a new
 * manifest, not new engine code.
 *
 * The manifest also captures peer-dependency floors — the lesson from the
 * prototype, where bumping inngest alone broke installs because v4 requires
 * typescript>=5.8.0. The verifier uses these to decide what else must move.
 */

import { z } from "zod";

/** Identifier of a single transform or review-flag, e.g. "T1" or "F2". */
export const TransformId = z.string().min(1);

/** A package version floor that must be satisfied for the migration to verify. */
export const PeerFloor = z.object({
  /** Package name, e.g. "typescript" or "inngest". */
  name: z.string(),
  /** Semver range the package must satisfy, e.g. ">=5.8.0". */
  range: z.string(),
});

/**
 * A manifest. Authored as YAML or JSON by the provider; validated with Zod
 * before the engine runs anything.
 */
export const Manifest = z.object({
  /** Human-readable name, e.g. "Inngest TypeScript SDK v3 -> v4". */
  name: z.string(),
  /** The provider/slug this campaign belongs to, e.g. "inngest". */
  provider: z.string(),
  /** Engine-internal key selecting which transform set to run. */
  transformSet: z.enum(["inngest-v3-to-v4", "knock-v0-to-v1"]),
  /** Package being upgraded. */
  package: z.object({
    name: z.string(),
    from: z.string(), // e.g. "^3.0.0"
    to: z.string(), // e.g. "^4.0.0"
  }),
  /** Additional packages whose versions must move for the upgrade to verify. */
  peerFloors: z.array(PeerFloor).default([]),
  /** Transform ids the provider has opted into. Defaults to all in the set. */
  transforms: z.array(TransformId).optional(),
  /** Free-text notes rendered into the PR body. */
  notes: z.string().optional(),
});
export type Manifest = z.infer<typeof Manifest>;

/** A validated manifest plus the package's own (resolved) module path. */
export type LoadedManifest = Manifest;
