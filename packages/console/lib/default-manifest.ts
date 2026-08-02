import type { Manifest } from "@api-migrator/engine";

/** Plain client-safe data used to seed the new-campaign form. */
export const DEFAULT_INNGEST_MANIFEST = {
  name: "Inngest TypeScript SDK v3 -> v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  runtime: {
    node: {
      minimumMajor: 20,
      profile: "node22-bookworm-slim-2026-07",
      packageJson: "package.json",
      dockerfile: "Dockerfile",
    },
  },
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: "^5.8.0" }],
} satisfies Manifest;

export const DEFAULT_INNGEST_MANIFEST_JSON = JSON.stringify(
  DEFAULT_INNGEST_MANIFEST,
  null,
  2
);
