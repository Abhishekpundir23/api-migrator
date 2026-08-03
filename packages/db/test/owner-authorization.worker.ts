import { parentPort, workerData } from "node:worker_threads";
import {
  closeDb,
  consumeOwnerAuthorization,
  getDb,
  type OwnerAuthorizationConsumptionInput,
} from "../src/index.js";

interface WorkerInput {
  path: string;
  authorization: OwnerAuthorizationConsumptionInput;
  holdAfterConsume?: boolean;
}

const input = workerData as WorkerInput;

try {
  getDb(input.path);
  consumeOwnerAuthorization(input.authorization);
  parentPort?.postMessage({ ok: true });
  if (input.holdAfterConsume) {
    // The parent terminates this worker to model an abrupt process death after
    // the security boundary has reported success but before graceful close.
    await new Promise<never>(() => {});
  }
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  closeDb();
}
