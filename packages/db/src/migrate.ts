import { closeDb, getDb, migrate, resolveDatabasePath } from "./client.js";
import { loadEnv } from "./env.js";

loadEnv();

const path = process.argv[2];
const db = getDb(path);

try {
  migrate(db);
  console.log(`Database ready: ${resolveDatabasePath(path)}`);
} finally {
  closeDb();
}
