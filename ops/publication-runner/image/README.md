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

The standalone integration resolves the image to its immutable local ID. Each
phase creates a retained container with a random attempt label, validates its
ownership, and starts it by ID. Bounded cleanup removes only that owned ID and
confirms absence before the temporary workspace is deleted or success is
printed. If create completion or cleanup is uncertain, the command fails and
reports the retained workspace path; do not delete it until the matching
container's ownership and absence have been checked. This protects command
timeouts, not an externally killed orchestrator, host crash, or hostile Docker
daemon. The native joined fixture keeps its separate cleanup coordinator.

To exercise real Docker client-timeout and nonzero-exit cleanup explicitly:

```bash
FIXTURE_TEST_IMAGE=$(docker image inspect --format '{{.Id}}' api-migrator-runner:local) \
  node --test ops/publication-runner/image/test/docker-fixture-executor-docker.mjs
```

The integration script uses real containers and proves the phase protocol and
result bindings. Its Inngest fixture uses the complete audited transform set
and an explicit operator-declared `long-running` deployment; it asserts zero
review findings and preservation of the declaration in runner evidence. It
does not infer hosting from the container or omit F12 to obtain a passing run.
It does not prove the Linux systemd, cgroup, nftables, L7
gateway, teardown-observer, or independent-signer controls. Live host activation
and external publication remain disabled until those controls pass a supervised
disposable-host drill.

Runner v1 deliberately accepts only a single root npm package with one
`package-lock.json` or `npm-shrinkwrap.json`. Workspaces, nested package roots,
local/archive dependencies, repository package-manager configuration, and
non-registry override/resolution values fail before the online phase.
