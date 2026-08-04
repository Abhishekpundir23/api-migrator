# Runner image

This directory builds the minimal credential-free Node 22 runner used by the
publication-runner contract. Its fixed protocol has four phases:

1. `prepare` validates and extracts the canonical source bundle and constructs
   deterministic baseline/candidate source roots plus minimal npm install
   projections with no network.
2. `install` receives only `package.json`, the active lockfile, the sealed
   preparation record, and the plan. It cannot read the extracted repository;
   it installs registry-only dependencies with lifecycle scripts disabled and
   is the only phase permitted transport egress.
3. `migrate` verifies the host-carried preparation/install digests, imports the
   dependency output into the still-sealed source roots, and runs the
   deterministic migration offline.
4. `verify` runs all required checks offline and emits canonical, blocker-free
   runner evidence. The host accepts that file only when its digest and
   preflight match the verify process's sole trusted status line.

Build and test it from the repository root:

```bash
npm run runner:image:build
npm run runner:image:verify
npm run runner:image:integration
```

The integration script uses real containers and proves the phase protocol and
result bindings. It does not prove the Linux systemd, cgroup, nftables, L7
gateway, teardown-observer, or independent-signer controls. Live host activation
and external publication remain disabled until those controls pass a supervised
disposable-host drill.

Runner v1 deliberately accepts only a single root npm package with one
`package-lock.json` or `npm-shrinkwrap.json`. Workspaces, nested package roots,
local/archive dependencies, repository package-manager configuration, and
non-registry override/resolution values fail before the online phase.
