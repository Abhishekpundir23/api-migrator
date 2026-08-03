import { consumeOperatorApprovalToken } from "./approval";

export class RunBusyError extends Error {
  constructor() {
    super("another migration request is already running; wait for it to finish");
    this.name = "RunBusyError";
  }
}

let active = 0;

/** Local pilot guard: only one batch may execute in this process at a time. */
export async function withRunLock<T>(operation: () => Promise<T>): Promise<T> {
  if (active >= 1) throw new RunBusyError();
  active += 1;
  try {
    return await operation();
  } finally {
    active -= 1;
  }
}

/** Acquire the process lock before consuming a one-shot v2 operator approval. */
export function withOperatorApprovalRunLock<T>(
  token: string,
  expiresAt: number,
  operation: () => Promise<T>
): Promise<T> {
  return withRunLock(async () => {
    // This is deliberately the first action after lock acquisition. A busy
    // request never burns its token, while an acquired replay still fails.
    consumeOperatorApprovalToken(token, expiresAt);
    return operation();
  });
}
