/**
 * Verifier — runs type-checking (and optionally tests) against a target repo
 * and reports whether the migration introduced new errors.
 *
 * The central subtlety: real-world repos rarely type-check clean out of the
 * box (missing optional deps, env-only packages). So we capture a BASELINE of
 * errors before transforming, then diff against the post-transform errors. Only
 * newly-introduced errors count as verification failures — this stops us from
 * rejecting a correct migration because of a pre-existing `Cannot find module
 * '@upstash/...'` the customer already lived with.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Options controlling verification, including dependency installation. */
export interface VerifyOptions {
  /**
   * If true, run `npm install` before type-checking when node_modules is absent
   * (e.g. on a fresh shallow clone). Default false — installs are slow and
   * mutate the repo, so this is opt-in.
   */
  install?: boolean;
  /**
   * Extra args passed to `npm install` (e.g. ["--legacy-peer-deps"]).
   * Defaults to ["--legacy-peer-deps","--no-audit","--no-fund"] because
   * breaking-change migrations frequently tighten peer deps and break installs
   * (we hit exactly this with inngest v4 needing typescript>=5.8.0).
   */
  installArgs?: string[];
}

/** One tsc error line, parsed. */
export interface TypeError {
  file: string;
  line: number | null;
  col: number | null;
  code: string;
  message: string;
  /** The raw line, for debugging. */
  raw: string;
}

/** Result of a verification pass. */
export interface VerifyResult {
  /** Did we get any NEW errors relative to the baseline? */
  ok: boolean;
  /** Errors present before the transform (pre-existing, not our problem). */
  baseline: TypeError[];
  /** Errors present after the transform. */
  after: TypeError[];
  /** Errors introduced by the transform (after - baseline). */
  introduced: TypeError[];
  /** True if tsc itself couldn't run (no TS, no package.json, etc.). */
  skipped: boolean;
  skipReason?: string;
}

const TS_ERROR = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

function parseTscErrors(stdout: string): TypeError[] {
  const out: TypeError[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(TS_ERROR);
    if (m) {
      out.push({
        file: m[1]!,
        line: Number(m[2]),
        col: Number(m[3]),
        code: m[4]!,
        message: m[5]!,
        raw: line,
      });
    }
  }
  return out;
}

/**
 * Capture the current type errors of a repo (the baseline).
 * Returns null if type-checking can't run.
 */
export function captureBaseline(repoPath: string, opts: VerifyOptions = {}): Promise<TypeError[] | null> {
  return runTsc(repoPath, opts).then((r) => (r.skipped ? null : r.after));
}

/**
 * Install dependencies if requested and node_modules is absent.
 * Returns true if deps are available after this call (or were already there).
 */
export function installDeps(repoPath: string, opts: VerifyOptions = {}): { ok: boolean; reason?: string } {
  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, reason: "no package.json" };
  // Already installed? Nothing to do.
  if (existsSync(join(repoPath, "node_modules"))) return { ok: true };
  if (!opts.install) return { ok: false, reason: "node_modules absent; install not requested" };

  const args = ["install", ...(opts.installArgs ?? ["--legacy-peer-deps", "--no-audit", "--no-fund"])];
  try {
    execFileSync("npm", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    return { ok: true };
  } catch (e: any) {
    return {
      ok: false,
      reason: `npm install failed: ${(e.stderr?.toString() ?? e.message ?? "").slice(0, 200)}`,
    };
  }
}

/** Run tsc --noEmit in the repo and parse errors. */
export function runTsc(repoPath: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) {
    return Promise.resolve(skipped("no package.json"));
  }
  // Optionally install deps if node_modules is absent (fresh clone case).
  const installed = installDeps(repoPath, opts);
  if (!installed.ok) {
    return Promise.resolve(skipped(installed.reason ?? "dependencies unavailable"));
  }
  // Need a local typescript to type-check; if it's absent we can't verify here.
  const hasTs = existsSync(join(repoPath, "node_modules", "typescript", "package.json"));
  if (!hasTs) {
    return Promise.resolve(skipped("no local typescript install"));
  }

  return new Promise((resolve) => {
    let stdout = "";
    try {
      // --noEmit so we don't write build output into the customer repo.
      stdout = execFileSync(
        "npx",
        ["--no-install", "tsc", "--noEmit", "--pretty", "false"],
        { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }
      ).toString();
    } catch (e: any) {
      // tsc exits non-zero on type errors; its output is on stdout/stderr.
      stdout = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    }
    const after = parseTscErrors(stdout);
    resolve({
      ok: true, // ok-ness vs baseline computed by verify(), not here
      baseline: [],
      after,
      introduced: [],
      skipped: false,
    });
  });
}

/**
 * Verify: compare post-transform errors against a captured baseline.
 * `ok` is true iff the transform introduced no new errors.
 */
export function verify(
  repoPath: string,
  baseline: TypeError[] | null,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  return runTsc(repoPath, opts).then((r) => {
    if (r.skipped) return r;
    const base = baseline ?? [];
    const baseSet = new Set(base.map(signature));
    const introduced = r.after.filter((e) => !baseSet.has(signature(e)));
    return {
      ...r,
      baseline: base,
      introduced,
      ok: introduced.length === 0,
    };
  });
}

/** Stable signature for error dedup across baseline/after. */
function signature(e: TypeError): string {
  return `${e.file}:${e.line}:${e.code}:${e.message}`;
}

function skipped(reason: string): VerifyResult {
  return {
    ok: true,
    baseline: [],
    after: [],
    introduced: [],
    skipped: true,
    skipReason: reason,
  };
}

/** Best-effort: does the repo declare a `test` script? */
export function hasTestScript(repoPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
    return Boolean(pkg.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1");
  } catch {
    return false;
  }
}
