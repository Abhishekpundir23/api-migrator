import { Manifest } from "@api-migrator/engine";

/** Stricter creation boundary; stored legacy manifests remain readable. */
export const NewCampaignManifest = Manifest.refine(
  (manifest) => manifest.transformSet !== "inngest-v3-to-v4" || manifest.deployment !== undefined,
  { path: ["deployment"], message: "Choose deployment.kind: long-running or serverless. This is an operator declaration, not hosting verification." }
);
