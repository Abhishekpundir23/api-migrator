/** Explicit one-time initialization for the durable owner-authorization ledger. */

import { argv, exit } from "node:process";
import { getDb, initializeOwnerAuthorizationStore, migrate } from "./client.js";
import { loadEnv } from "./env.js";

loadEnv();

const args = argv.slice(2);
if (args.length !== 1 || args[0] !== "--activate") {
  console.error("Usage: npm run init:owner-store --workspace @api-migrator/db -- --activate");
  console.error(
    "Requires API_MIGRATOR_REPLAY_STORE_ID and an absolute API_MIGRATOR_REPLAY_ANCHOR_PATH in a separate owner-controlled persistent directory."
  );
  exit(1);
}

try {
  const db = getDb();
  migrate(db);
  const identity = initializeOwnerAuthorizationStore(db);
  console.log(`Owner-authorization replay store initialized: ${identity.storeId}`);
} catch {
  console.error("Owner-authorization replay store initialization failed");
  exit(1);
}
