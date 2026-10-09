import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBatchImage } from '../batch-image.mjs';
import { classifyBatchResult } from '../batch-result.mjs';

const enabled = process.env.API_MIGRATOR_DOCKER_TEST === '1';
const image = 'node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const D = c => `sha256:${c.repeat(64)}`;
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);

// Supplemental bootstrap control-flow coverage, NOT cloud isolation evidence.
// Apt/downloads/nft/metadata/Docker build are controlled fixtures; real Linux
// accounts, runuser, env clearing, tar/hash verification, build, sealing and the
// generated root emitter execute. Separate Docker tests run real image phases.
test('generated image bootstrap enforces privilege, sealing, runtime and failure/log contracts', { skip: !enabled, timeout: 300_000 }, async t => {
  const fixtures = mkdtempSync(join(tmpdir(), 'batch-image-native-')); chmodSync(fixtures, 0o755);
  t.after(() => rmSync(fixtures, { recursive: true, force: true }));
  const archive = join(fixtures, 'node.tar.xz');
  const download = spawnSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '90', '--max-filesize', '67108864',
    '--output', archive, 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz'], { timeout: 95_000, encoding: 'utf8' });
  assert.equal(download.status, 0, download.stderr);
  assert.equal(sha(readFileSync(archive)), 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307');
  const unpack = spawnSync('xz', ['-dc', archive], { maxBuffer: 256 * 1024 * 1024 }); assert.equal(unpack.status, 0);
  writeFileSync(join(fixtures, 'node.tar'), unpack.stdout);
  const summary = { schemaVersion: 1, profile: 'batch-public-image-phase-smoke-v1', image: D('a'), planDigest: D('b'), evidenceDigest: D('c'),
    output: { preflightId: `pf_${'d'.repeat(64)}`, artifactDigest: D('e'), candidateTreeSha: 'f'.repeat(40) },
    phases: [{ phase: 'prepare', status: 'passed', preparedStateDigest: D('1') },
      { phase: 'install', status: 'passed', preparedStateDigest: D('1'), installStateDigest: D('2') },
      { phase: 'migrate', status: 'passed', preparedStateDigest: D('1'), installStateDigest: D('2'), dependencyStateDigest: D('3') },
      { phase: 'verify', status: 'passed', planDigest: D('b'), evidenceDigest: D('c'), preflightId: `pf_${'d'.repeat(64)}` }],
    cleanup: { containers: 'verified_absent', workspace: 'verified_absent' }, metadataIsolation: 'container_denied_root_reachable',
    dnsEvidence: 'synthetic_lifetime_scaffolding', securityDrill: false, selfAttested: true, releaseEvidenceEligible: false,
    activationBlocked: true, externalSigningEligible: false, productionReady: false };
  for (const scenario of ['success', 'provision-failure', 'rootless', 'build-failure', 'build-timeout', 'image-build-failure',
    'phase-failure', 'phase-timeout', 'escaping-link', 'root-metadata-failure', 'worker-metadata-access']) {
    await t.test(scenario, { timeout: 50_000 }, st => {
      const dir = join(fixtures, scenario), repo = join(dir, 'repo');
      mkdirSync(join(repo, 'ops/gcp-trial'), { recursive: true });
      const pkg = { name: 'bootstrap-control-fixture', version: '1.0.0', workspaces: ['packages/*'], scripts: { 'build:packages': 'node build.cjs' } };
      writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg));
      const packages = { '': pkg };
      for (const name of ['engine', 'db', 'app', 'runner']) {
        const path = `packages/${name}`, workspace = { name: `@api-migrator/${name}`, version: '1.0.0' };
        mkdirSync(join(repo, path), { recursive: true });
        writeFileSync(join(repo, path, 'package.json'), JSON.stringify(workspace));
        packages[path] = workspace;
        packages[`node_modules/@api-migrator/${name}`] = { resolved: path, link: true };
      }
      writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages }));
      writeFileSync(join(repo, 'build.cjs'), `const fs=require('node:fs');if(process.getuid()===0||process.env.GITHUB_TOKEN||process.env.GOOGLE_APPLICATION_CREDENTIALS)process.exit(91);
if(!fs.existsSync('/tmp/native-boundary/nft-'+process.getuid()))process.exit(92);
fs.writeFileSync('build-uid',String(process.getuid()));
${scenario === 'build-failure' ? 'process.exit(37);' : scenario === 'build-timeout' ? 'setInterval(()=>{},1000);' : scenario === 'escaping-link' ? "fs.symlinkSync('/etc/passwd','escape');" : ''}`);
      const controller = `import fs from 'node:fs';
if(process.getuid()!==0||process.env.GITHUB_TOKEN||process.env.GOOGLE_APPLICATION_CREDENTIALS)process.exit(93);
const root=process.cwd();for(const p of [root,root+'/build-uid',root+'/ops/gcp-trial/run-batch-image-smoke.mjs']){const s=fs.statSync(p);if(s.uid!==0||s.gid!==0||(s.mode&0o222))process.exit(94);}
const buildUid=Number(fs.readFileSync('build-uid','utf8'));if(!fs.existsSync('/tmp/native-boundary/nft-'+buildUid))process.exit(95);
const uid=Number(process.argv[process.argv.indexOf('--uid')+1]);if(!fs.existsSync('/tmp/native-boundary/nft-'+uid))process.exit(96);
if(Number(process.argv[process.argv.indexOf('--deadline')+1])-Date.now()>1200000)process.exit(42);
${scenario === 'phase-failure' ? 'process.exit(38);' : scenario === 'phase-timeout' ? 'setInterval(()=>{},1000);' : `console.log(${JSON.stringify('API_MIGRATOR_BATCH_IMAGE_SUMMARY ' + canonical(summary))});`}`;
      writeFileSync(join(repo, 'ops/gcp-trial/run-batch-image-smoke.mjs'), controller);
      const tar = spawnSync('tar', ['-czf', '-', '-C', dir, 'repo'], { maxBuffer: 1_048_576 }); assert.equal(tar.status, 0);
      writeFileSync(join(dir, 'source.tar.gz'), tar.stdout); chmodSync(dir, 0o755);
      const now = Date.now(), runId = 'abcdef0123456789abcdef0123456789';
      const prepared = prepareBatchImage({ projectId: 'project-32bf49a2-bd30-4956-850', runId, sourceRevision: 'b'.repeat(40),
        sourceArchiveSha256: sha(tar.stdout), bootImage: 'batch-debian-12-official-20261008-00', network: 'api-migrator-trial-net',
        subnetwork: 'api-migrator-trial-sub', deleteAt: now + 3_600_000 }, { nowMs: now });
      writeFileSync(join(dir, 'startup.sh'), prepared.job.taskGroups[0].taskSpec.runnables[0].script.text);
      const stub = (name, body) => `printf '%s' '${Buffer.from('#!/bin/bash\nset -euo pipefail\n' + body).toString('base64')}' | base64 -d > /usr/bin/${name}\nchmod 755 /usr/bin/${name}\n`;
      const setup = `mkdir -m 0777 /tmp/native-boundary\n/usr/local/bin/node -e "require('node:net').createServer().listen('/var/run/docker.sock')" >/tmp/socket.log 2>&1 &\nsocket_pid=$!\nfor n in 1 2 3 4 5; do [ -S /var/run/docker.sock ] && break; sleep 0.1; done\nchmod 660 /var/run/docker.sock\n` +
        stub('apt-get', `exit ${scenario === 'provision-failure' ? 39 : 0}\n`) + stub('xz', 'cat /fixtures/node.tar\n') +
        stub('docker', `if [ "$1" = info ]; then echo '${JSON.stringify({ OSType: 'linux', CgroupVersion: '2', SecurityOptions: scenario === 'rootless' ? ['name=rootless'] : ['name=seccomp'] })}'; exit 0; fi\n[ "$1" = build ] || exit 97\n${scenario === 'image-build-failure' ? 'exit 40' : `while [ "$#" -gt 0 ]; do if [ "$1" = --iidfile ]; then printf '%s' '${D('a')}' > "$2"; exit 0; fi; shift; done\nexit 98`}\n`) +
        stub('nft', `rules=$(cat)\nuid=$(printf '%s' "$rules" | sed -n 's/.*meta skuid \\([0-9]*\\) ip daddr 169.254.169.254 reject/\\1/p')\n[ -n "$uid" ] || exit 99\ntouch /tmp/native-boundary/nft-$uid\n`) +
        stub('curl', `dest=; url=\nwhile [ "$#" -gt 0 ]; do case "$1" in --output) dest=$2; shift 2;; *) url=$1; shift;; esac; done\ncase "$url" in\n http://169.254.169.254/*|http://\\[fd20:ce::254\\]/*) if [ "$(id -u)" -eq 0 ]; then printf '${scenario === 'root-metadata-failure' ? '503' : '200'}'; exit 0; fi; [ -f /tmp/native-boundary/nft-$(id -u) ] || exit 97; exit ${scenario === 'worker-metadata-access' ? 0 : 7};;\n https://nodejs.org/*) cp /fixtures/node.tar.xz "$dest";;\n https://codeload.github.com/*) [ "$(id -u)" -ne 0 ] || exit 98; cp /fixtures/${scenario}/source.tar.gz "$dest";;\n *) exit 99;; esac\n`) +
        stub('pkill', `exec /usr/local/bin/node -e "const fs=require('fs');let found=false;for(const p of fs.readdirSync('/proc'))if(/^[0-9]+$/.test(p)){try{if(fs.statSync('/proc/'+p).uid===Number(process.argv[1])){process.kill(Number(p),'SIGKILL');found=true}}catch{}}process.exit(found?0:1)" "$3"\n`) +
        stub('pgrep', `exec /usr/local/bin/node -e "const fs=require('fs');for(const p of fs.readdirSync('/proc'))if(/^[0-9]+$/.test(p)){try{if(fs.statSync('/proc/'+p).uid===Number(process.argv[1]))process.exit(0)}catch{}}process.exit(1)" "$2"\n`) +
        (scenario.endsWith('timeout') ? 'mv /usr/bin/timeout /usr/bin/native-timeout\n' + stub('timeout', `if [ "\${3:-}" = ${scenario === 'build-timeout' ? 600 : 1200} ]; then set -- "$1" "$2" 2 "\${@:4}"; fi\nexec /usr/bin/native-timeout "$@"\n`) : '') +
        `export GITHUB_TOKEN=must-not-leak GOOGLE_APPLICATION_CREDENTIALS=/secret.json\nset +e\nbash /fixtures/${scenario}/startup.sh\ncode=$?\nkill "$socket_pid"\nif [ "$code" -ne 0 ]; then for log in /var/lib/api-migrator-batch-${runId}/setup.log /var/lib/api-migrator-batch-${runId}/controller.log; do [ ! -f "$log" ] || cat "$log" >&2; done; fi\nexit "$code"\n`;
      const name = `batch-image-native-${randomUUID()}`;
      st.after(() => {
        spawnSync('docker', ['rm', '-f', name], { timeout: 15_000 });
        const check = spawnSync('docker', ['ps', '-aq', '--filter', `name=^/${name}$`], { encoding: 'utf8', timeout: 15_000 });
        assert.equal(check.status, 0); assert.equal(check.stdout.trim(), '');
      });
      const result = spawnSync('docker', ['run', '--rm', '--name', name, '--platform', 'linux/amd64', '--network', 'none',
        '--mount', `type=bind,source=${fixtures},target=/fixtures,readonly`, '--tmpfs', '/tmp:rw,nosuid,exec,size=128m',
        '--tmpfs', '/var/lib:rw,nosuid,exec,size=256m', '--memory=768m', '--pids-limit=256', '--cap-drop=ALL',
        ...['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER', 'KILL'].flatMap(cap => ['--cap-add', cap]),
        '--security-opt=no-new-privileges', '--user=0:0', '-i', image, 'bash', '-se'],
      { input: setup, encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
      const expected = { success: 0, 'provision-failure': 39, rootless: 86, 'build-failure': 37, 'build-timeout': 124,
        'image-build-failure': 40, 'phase-failure': 38, 'phase-timeout': 124, 'escaping-link': 1,
        'root-metadata-failure': 83, 'worker-metadata-access': 84 }[scenario];
      assert.equal(result.status, expected, result.stderr + result.stdout);
      const records = result.stdout.split('\n').filter(line => line.startsWith('API_MIGRATOR_BATCH_'));
      if (scenario === 'provision-failure') { assert.equal(records.length, 0); return; }
      const markers = records.filter(line => line.startsWith('API_MIGRATOR_BATCH_RESULT ')); assert.equal(markers.length, 1);
      const marker = JSON.parse(markers[0].slice('API_MIGRATOR_BATCH_RESULT '.length));
      assert.equal(marker.status, expected === 0 ? 'passed' : 'failed'); assert.equal(marker.exitCode, expected);
      const accepted = { name: `projects/${prepared.projectId}/locations/us-central1/jobs/${prepared.jobId}`, uid: 'native-fixture', createTime: new Date(now + 1).toISOString() };
      const classified = classifyBatchResult({ prepared, accepted, job: { ...structuredClone(prepared.job), ...accepted,
        updateTime: new Date(Date.now()).toISOString(), status: { state: expected === 0 ? 'SUCCEEDED' : 'FAILED' } },
      logs: { jobUid: accepted.uid, complete: true, records } });
      assert.equal(classified.smoke, expected === 0 ? 'passed' : 'failed'); assert.equal(classified.cleanup, 'unverified');
    });
  }
});
