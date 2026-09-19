export type StoreFailureCode = "input_invalid" | "job_conflict" | "clock_rollback"
  | "store_unsafe" | "store_mismatch" | "store_corrupt" | "store_full" | "store_unavailable";

const CODES = new Set<StoreFailureCode>(["input_invalid", "job_conflict", "clock_rollback",
  "store_unsafe", "store_mismatch", "store_corrupt", "store_full", "store_unavailable"]);
export class JobStoreError extends Error {
  readonly code: StoreFailureCode;
  constructor(code: StoreFailureCode) {
    const safeCode = CODES.has(code) ? code : "store_unavailable";
    super(safeCode);
    this.name = "JobStoreError";
    this.code = safeCode;
  }
}
export type StorePolicy = { applicationCheckout: string; migrationWorkspaceRoots: readonly string[] };
export type StoredJobRow = {
  campaignId: string; runId: string; jobId: string;
  revision: 1 | 2 | 3; intentDigest: string; recordDigest: string; canonicalRecord: string;
};
export interface JobStore {
  readonly storeId: string;
  list(): readonly StoredJobRow[];
  read(campaignId: string, runId: string): StoredJobRow | null;
  observeTime(now: number): void;
  insert(row: StoredJobRow): { inserted: boolean; row: StoredJobRow };
  compareAndSwap(previous: StoredJobRow, next: StoredJobRow): { committed: boolean; row: StoredJobRow };
  close(): void;
}
