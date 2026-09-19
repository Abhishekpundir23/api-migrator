// Server-internal package surface. No singleton, native handle, or test hooks.
export { JobStoreError } from "./runner-job-store-contract.js";
export type { StoreFailureCode, StorePolicy, StoredJobRow, JobStore } from "./runner-job-store-contract.js";
export { initializeJobStore, openJobStore } from "./runner-job-store-sqlite.js";
