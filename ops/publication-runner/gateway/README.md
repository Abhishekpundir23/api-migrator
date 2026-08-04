# Static npm TLS-origin gateway contract

This directory is a self-contained **deployment contract**, not a deployed
gateway, Linux enforcement proof, runner attestation, or publication
authorization. It does not change or complete the parent publication-runner
wrapper. External-source publication remains disabled until the rendered
artifacts are exercised on the actual hardened Linux host, the required probes
pass, an independent observer preserves the evidence, and the complete
supervised drill succeeds.

The narrow profile is `static-envoy-sni-passthrough-v1`:

```text
dedicated runner UID
        |
        | every TCP/443 flow is forcibly redirected by host nftables
        v
127.0.0.1 / ::1 : fixed high port
        |
        | static Envoy TLS inspector; exact registry.npmjs.org SNI only
        v
dedicated gateway UID
        |
        | host nftables allows only the plan-bound numeric IP set on TCP/443
        v
registry.npmjs.org
```

Envoy passes TLS bytes through unchanged. The pinned Node/npm client—not
Envoy—must validate the public certificate for `registry.npmjs.org` with
`strict-ssl=true` and no repository-controlled CA, proxy, or package-manager
configuration. A cross-origin redirect opens a connection with a different SNI
and is rejected when the forced transport policy is working.

## Deliberately excluded

This contract has no:

- Envoy dynamic forward proxy, DNS cluster, control plane, xDS, hot reload, or
  admin listener;
- default Envoy filter chain or wildcard hostname;
- direct runner-UID route to registry IPs;
- shared runner/gateway OS identity;
- signing key or function that signs a gateway receipt;
- GitHub credential, token, publisher, or repository mutation;
- claim that Envoy validates the upstream certificate;
- visibility into encrypted HTTP methods, paths, bodies, or same-origin
  redirects.

The gateway therefore enforces one TLS origin at SNI/transport level. It is not
an HTTP allowlist, malware scanner, package mirror, or proof that a tarball is
safe. Package-lock provenance, integrity verification, lifecycle-script
disablement, npm audit/fund disablement, and the trusted client TLS policy
remain separate required controls.

## Artifacts

- `gateway-contract.mjs` strictly validates one canonical deployment contract,
  renders exact Envoy and nftables bytes, validates observer receipts, and
  exposes a small stdout-only CLI.
- `templates/forced-gateway-egress.nft.in` contains the forced two-identity
  host policy. After output DNAT, the runner UID may reach only the loopback
  listener. The gateway UID may open new connections only to the exact npm IP
  set on TCP/443.
- `schemas/gateway-receipt.schema.json` documents the raw receipt shape. The
  JavaScript validator is stricter: it also enforces canonical global-unicast
  addresses, exact contract equality, lifecycle ordering, and plan expiry.
- `examples/` contains readable presentation examples. They are intentionally
  pretty-printed and therefore are not accepted as exact canonical input bytes.
- `test/gateway-contract.test.mjs` directly exercises rendering, substitution
  rejection, strict receipts, and the intended fail-closed shapes. These tests
  do not run Envoy or nftables.

## Contract input

The trusted control plane supplies exact canonical JSON containing:

- the canonical runner job and plan digest/lifetime;
- the already reviewed parent egress-policy digest;
- the digest of the pinned Envoy executable or image used by provisioning;
- distinct, otherwise-idle runner and gateway UIDs;
- the fixed IPv4 and IPv6 loopback listeners and one high port;
- exactly `registry.npmjs.org:443` and its trusted, plan-bound numeric address
  set plus resolution evidence and expiry.

The address set is sorted and restricted to canonical global-unicast literals.
Private, loopback, link-local, documentation, benchmark, scoped, CIDR,
duplicate, noncanonical, stale, and excessive values fail closed.

To turn the readable example into canonical bytes for local inspection:

```bash
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { canonicalJson } from "./ops/publication-runner/gateway/gateway-contract.mjs";
  const value = JSON.parse(readFileSync(
    "./ops/publication-runner/gateway/examples/gateway-contract.example.json",
    "utf8"
  ));
  process.stdout.write(canonicalJson(value));
'
```

Production provisioning must create new root-owned files without shell
redirection races, reject symlinks and hard links, set restrictive modes, and
durably synchronize them. This renderer intentionally writes only to stdout;
it is not a privileged file installer.

Given an exact canonical contract file, the supported commands are:

```text
node ops/publication-runner/gateway/gateway-contract.mjs render-envoy CONTRACT.json
node ops/publication-runner/gateway/gateway-contract.mjs render-nft CONTRACT.json
node ops/publication-runner/gateway/gateway-contract.mjs render-record CONTRACT.json
node ops/publication-runner/gateway/gateway-contract.mjs validate-receipt CONTRACT.json RECEIPT.json
```

`render-record` returns only safe digests, table identity, profile, and job ID.
`validate-receipt` accepts exact canonical receipt bytes and returns only a safe
receipt digest, job ID, observation time, and passed status.

## Required deployment sequence

A real control plane must, at minimum:

1. Validate the parent runner plan and this exact contract before its deadline.
2. Prove both dedicated UIDs are otherwise idle and the derived nftables table
   does not exist.
3. Resolve the trusted Envoy executable/image to the contract's runtime digest.
4. Render root-owned configuration and run that pinned Envoy's native
   `--mode validate` check.
5. Install the rendered nftables table before either dedicated identity can
   create a socket.
6. Start Envoy under only the gateway UID with the rendered static config,
   bounded stdout/stderr, a fixed environment, and no writable config path.
7. Independently confirm both loopback listeners belong to that exact gateway
   process and invocation.
8. Run trusted negative probes for plaintext, absent SNI, wrong SNI, direct
   non-443 output, direct registry-IP bypass, and non-npm destinations. No
   repository code participates in these probes.
9. Run only the trusted lifecycle-disabled dependency-fetch phase online.
10. Stop the gateway, make both identities idle, and close the parent network
    before migration or repository-controlled verification begins.
11. Recompute bounded access-log and nftables ruleset/counter evidence, remove
    the exact table, confirm its absence, and preserve teardown evidence outside
    the disposable workspace.

The Linux drill must verify actual hook order: the nftables output DNAT must
occur before the filter chain sees the runner flow, both loopback families must
reach the intended listener, and gateway downstream response packets must not
be blocked. Text rendering and `nft -c` are necessary but insufficient.

The systemd boundary must independently bind the unit definition, invocation
ID, cgroup, runtime deadline, kill mode, executable/config digests, process
identities, and final empty-cgroup outcome. Neither `INVOCATION_ID` nor a PID
written by the job proves this state.

## Receipt semantics

An independent observer may construct a canonical gateway receipt only after
all required evidence exists and teardown is complete. The receipt binds:

- the exact plan, contract, Envoy config, nftables policy, runtime, UIDs,
  listeners, origin, and derived table;
- the systemd invocation and independently derived gateway-process instance;
- ordered online, offline, stop, UID-idle, policy-removal, and observation
  times before plan expiry;
- retrievable evidence for native Envoy config validation, the pinned TLS
  client policy, installed ruleset, transport counters, bounded gateway log,
  offline closure, teardown, and the matching deployment drill.

Every evidence member is mandatory and has `status: "passed"`. Unknown fields,
failed evidence, digest drift, identity drift, missing teardown, and expired or
unordered events are rejected.

A receipt is still unsigned raw evidence. The runner, gateway, wrapper, or
operator cannot authorize publication by producing one. A separately deployed
observer must independently recompute it and include its digest in the broader
runner evidence before an out-of-job attestation signer may issue the existing
domain-separated runner envelope. No signing key belongs in this directory.

## Focused tests

Run without installing dependencies:

```bash
node --test ops/publication-runner/gateway/test/gateway-contract.test.mjs
```

Passing tests establish deterministic contract behavior only. Required
deployment evidence still includes native Envoy validation, `nft -c`, live
wrong/no-SNI and bypass probes, strict npm certificate validation, ruleset
counters, offline failure probes, cgroup/process/network-namespace observation,
policy removal, workspace teardown, and a supervised end-to-end sandbox drill.
