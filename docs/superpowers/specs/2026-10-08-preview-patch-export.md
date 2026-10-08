# Local preview patch export

## Purpose

Let the owner inspect the exact proposed changes before considering approval.
The current preview retains changed paths and fingerprints but deletes its
disposable candidate checkout. This increment exports a local review bundle;
it does not enable publication or claim independent runner verification.

## Contract

- Add opt-in `--preview-bundle /absolute/new-directory` to the existing preview CLI.
- Add optional `previewBundlePath` to the internal migration input. Reject it for
  owner challenges, runner-attested jobs, and publication before clone or auth.
- Export `candidate.patch` as raw Git diff bytes for the already-staged candidate,
  including binary changes, file modes, additions and deletions. Disable external
  diff drivers, textconv and color. Bound output to 8 MiB and reject larger patches.
- Export `receipt.json` with version 1, repository slug, preflight ID, base branch,
  base commit, candidate tree, artifact digest, preview status, blocker strings,
  and patch SHA-256 and byte length. Mark it local and non-authorizing.
- A successful bundle must round-trip from its recorded base commit to its
  candidate tree with `git apply --index`. No changes means an empty patch and
  the unchanged base tree. Blocked previews may export but remain visibly blocked.
- The requested directory must not exist. Its existing parent must resolve
  outside the workspace, be an owner-owned, owner-only regular directory, and
  not itself be a symlink. Reject dot segments, repeated separators and trailing
  separators rather than reinterpret an ambiguous path. Use a new 0700 directory and exclusive 0600 files.
  Reject Windows until equivalent ACL enforcement exists. Validate before clone.
- Never overwrite files or follow a destination symlink. Complete the receipt
  last; on failure clean up only files and the directory created by this export.
  Do not recursively remove arbitrary paths or mask the original failure.
- Do not expose raw source in logs, ordinary reports, database records, console
  responses, or exception messages. Only the opt-in bundle contains patch bytes.
- Default previews, all existing permission gates, authentication rules and
  publication behavior remain unchanged. No new dependency or cloud mutation.

## Acceptance

Real Git fixtures prove byte-preserving reconstruction, including non-UTF-8
content and binary data. Tests cover safe output permissions, new-only writes,
symlinks, invalid paths, size overflow, blocked/no-change runs, and rejection of
privileged usage before external callbacks. The full Node 22 CI command passes,
with Docker-enabled tests where the local runtime supports them.

## Limits

The bundle contains sensitive repository source. The operator controls its
retention and deletion. A digest is a consistency check, not a signature or a
trusted runner attestation. Neither a bundle nor a green local check authorizes
publication. Trusted runner integration and live cloud lifecycle drills remain
separate release gates.
