#!/bin/bash -p
set -Eeuo pipefail
umask 077

readonly TRUSTED_PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH=$TRUSTED_PATH
hash -r

[[ ${BASH_SOURCE[0]} == "$0" && $- == *p* && ${BASH_VERSINFO[0]} -ge 5 ]] \
  || { printf '%s\n' 'publication runner refused: direct Bash 5+ privileged mode is required' >&2; exit 1; }

die() {
  printf 'publication runner refused: %s\n' "$1" >&2
  exit 1
}

# Never let root-side language imports consult an inherited launch directory.
# All accepted inputs are absolute, and the wrapper itself must also be invoked
# by one absolute canonical path.
cd / || die "could not enter the trusted working directory"
[[ $(pwd -P) == / ]] || die "trusted working directory is not canonical"

usage() {
  die "usage: $0 PLAN_JSON PLAN_DIGEST SOURCE_ARCHIVE OUTPUT_DIR RAW_EVIDENCE_PATH"
}

[[ $# -eq 5 ]] || usage

# The image protocol and the host/gateway contracts are independently tested,
# but the checked-in host wrapper does not yet own the required forced-SNI
# gateway lifecycle between offline preparation, online install, and offline
# migration. Running its legacy direct-IP transport path would contradict the
# plan. Keep live host activation impossible until the Linux orchestrator
# replaces that path and the complete drill is independently observed.
die "live host activation is disabled until the forced L7 gateway lifecycle is integrated and drilled"

PLAN_PATH=$1
EXPECTED_PLAN_DIGEST=$2
SOURCE_PATH=$3
OUTPUT_PATH=$4
EVIDENCE_PATH=$5
RESULT_EVIDENCE_PATH="${EVIDENCE_PATH}.runner.json"

[[ $(uname -s) == Linux ]] || die "Linux is required"
[[ ${EUID} -eq 0 ]] || die "the disposable control-plane wrapper must run as root"
[[ ${INVOCATION_ID:-} =~ ^[a-f0-9]{32}$ ]] || die "a systemd disposable-unit INVOCATION_ID is required"

for command in awk basename chmod chown cmp cp date dirname env find getent grep head install jq mkdir mktemp mount nft pgrep podman python3 readlink rm sed setpriv sha256sum sleep sort stat sync timeout umount uname wc; do
  command -v "$command" >/dev/null 2>&1 || die "required command is unavailable: $command"
done

RUNNER_IMAGE=${API_MIGRATOR_RUNNER_IMAGE:-}
RUNNER_UID=${API_MIGRATOR_RUNNER_UID:-}
RUNNER_GID=${API_MIGRATOR_RUNNER_GID:-}
RUNNER_STORAGE_ROOT=${API_MIGRATOR_RUNNER_STORAGE_ROOT:-}
RUNNER_STORAGE_DRIVER=${API_MIGRATOR_RUNNER_STORAGE_DRIVER:-}
OCI_RUNTIME_PATH=${API_MIGRATOR_OCI_RUNTIME_PATH:-}
CONMON_PATH=${API_MIGRATOR_CONMON_PATH:-}
CONTROL_JOB_ID=${API_MIGRATOR_CONTROL_PLANE_JOB_ID:-}

[[ $RUNNER_IMAGE =~ ^[A-Za-z0-9._/:@+-]+@sha256:[a-f0-9]{64}$ ]] || die "a digest-pinned runner image is required"
[[ $RUNNER_UID =~ ^[1-9][0-9]*$ ]] || die "a dedicated non-root runner UID is required"
[[ $RUNNER_GID =~ ^[1-9][0-9]*$ ]] || die "a dedicated non-root runner GID is required"
[[ $RUNNER_STORAGE_ROOT == /* ]] || die "runner storage root must be absolute"
[[ $OCI_RUNTIME_PATH == /* && $CONMON_PATH == /* ]] \
  || die "trusted OCI runtime and conmon paths must be absolute"
[[ $RUNNER_STORAGE_ROOT =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || die "runner storage root contains unsupported path characters"
[[ $OCI_RUNTIME_PATH =~ ^/[A-Za-z0-9._/-]+$ && $CONMON_PATH =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || die "trusted runtime path contains unsupported characters"
[[ $RUNNER_STORAGE_DRIVER == overlay || $RUNNER_STORAGE_DRIVER == vfs ]] \
  || die "runner storage driver must be explicitly overlay or vfs"
[[ $EXPECTED_PLAN_DIGEST =~ ^sha256:[a-f0-9]{64}$ ]] || die "plan digest is invalid"
[[ $CONTROL_JOB_ID =~ ^previewjob_[a-f0-9]{64}$ ]] || die "control-plane job identity is invalid"

# Refuse ambient channels rather than merely hoping the child environment scrub
# is complete. Values are never printed.
SENSITIVE_ENV=(
  GH_TOKEN GITHUB_TOKEN GH_APP_ID GH_APP_PRIVATE_KEY GH_APP_PRIVATE_KEY_PATH
  GH_APP_INSTALLATION_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CLOUD_PROJECT AZURE_CLIENT_ID
  AZURE_CLIENT_SECRET AZURE_TENANT_ID DATABASE_URL API_MIGRATOR_DB_PATH
  API_MIGRATOR_OWNER_KEY_REGISTRY_PATH OPERATOR_APPROVAL_SECRET
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
  NPM_CONFIG_PROXY NPM_CONFIG_HTTPS_PROXY NPM_CONFIG_USERCONFIG npm_config_proxy
  npm_config_https_proxy npm_config_userconfig GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL
  GIT_CONFIG_SYSTEM NODE_OPTIONS NODE_PATH DOCKER_HOST CONTAINER_HOST
  BASH_ENV ENV CDPATH GLOBIGNORE
  LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH PYTHONHOME PERL5LIB RUBYLIB
  XDG_CONFIG_HOME XDG_DATA_HOME CONTAINERS_CONF CONTAINERS_STORAGE_CONF
  CONTAINERS_REGISTRIES_CONF CONTAINERS_MOUNTS_CONF CONTAINERS_POLICY CONTAINERS_AUTH_FILE
  REGISTRY_AUTH_FILE STORAGE_DRIVER STORAGE_OPTS DBUS_SESSION_BUS_ADDRESS
  SSH_AUTH_SOCK KUBECONFIG
)
for variable in "${SENSITIVE_ENV[@]}"; do
  [[ ${!variable+x} != x ]] || die "ambient credential, proxy, preload, or remote-engine environment is forbidden"
done

secure_root_ancestor_chain() {
  local path=$1 label=$2 current owner mode resolved
  resolved=$(readlink -f -- "$path")
  [[ $resolved == "$path" && -d $path ]] || die "$label path must be canonical and symlink-free"
  current=$path
  while :; do
    owner=$(stat -Lc '%u' -- "$current")
    mode=$(stat -Lc '%a' -- "$current")
    [[ $owner == 0 ]] || die "$label ancestor must be root-owned"
    (( (8#$mode & 8#022) == 0 )) || die "$label ancestor must not be group/world writable"
    [[ $current == / ]] && break
    current=$(dirname -- "$current")
  done
}

secure_root_file() {
  local path=$1 label=$2 owner mode links resolved parent
  [[ $path == /* && -f $path && ! -L $path ]] || die "$label must be an absolute regular non-symlink file"
  resolved=$(readlink -f -- "$path")
  [[ $resolved == "$path" ]] || die "$label path must be canonical and symlink-free"
  parent=$(dirname -- "$path")
  secure_root_ancestor_chain "$parent" "$label"
  owner=$(stat -Lc '%u' -- "$path")
  mode=$(stat -Lc '%a' -- "$path")
  links=$(stat -Lc '%h' -- "$path")
  [[ $owner == 0 && $links == 1 ]] || die "$label must be root-owned with one link"
  (( (8#$mode & 8#022) == 0 )) || die "$label must not be group/world writable"
}

secure_owner_only_input_file() {
  local path=$1 label=$2 mode
  secure_root_file "$path" "$label"
  mode=$(stat -Lc '%a' -- "$path")
  (( (8#$mode & 8#077) == 0 )) || die "$label must be owner-only"
}

secure_root_executable() {
  local path=$1 label=$2
  secure_root_file "$path" "$label"
  [[ -x $path ]] || die "$label must be executable"
}

secure_root_parent_for_new_path() {
  local path=$1 label=$2 parent owner mode
  [[ $path == /* && ! -e $path && ! -L $path ]] || die "$label must be a new absolute path"
  parent=$(readlink -f -- "$(dirname -- "$path")")
  [[ $parent/$(basename -- "$path") == "$path" ]] || die "$label path must be canonical and symlink-free"
  [[ -d $parent && ! -L $parent ]] || die "$label parent must be a real directory"
  secure_root_ancestor_chain "$parent" "$label"
  owner=$(stat -Lc '%u' -- "$parent")
  mode=$(stat -Lc '%a' -- "$parent")
  [[ $owner == 0 ]] || die "$label parent must be root-owned"
  (( (8#$mode & 8#022) == 0 )) || die "$label parent must not be group/world writable"
}

secure_runner_directory() {
  local path=$1 label=$2 owner mode parent resolved
  [[ -d $path && ! -L $path ]] || die "$label must be a real directory"
  resolved=$(readlink -f -- "$path")
  [[ $resolved == "$path" ]] || die "$label path must be canonical and symlink-free"
  parent=$(dirname -- "$path")
  secure_root_ancestor_chain "$parent" "$label"
  owner=$(stat -Lc '%u' -- "$path")
  mode=$(stat -Lc '%a' -- "$path")
  [[ $owner == "$RUNNER_UID" ]] || die "$label must be owned by the dedicated runner UID"
  (( (8#$mode & 8#077) == 0 )) || die "$label must be owner-only"
}

WRAPPER_PATH=$(readlink -f -- "$0")
[[ $WRAPPER_PATH == "$0" ]] || die "runner wrapper path must be absolute and canonical"
secure_root_file "$WRAPPER_PATH" "runner wrapper"
secure_owner_only_input_file "$PLAN_PATH" "plan"
secure_owner_only_input_file "$SOURCE_PATH" "source archive"
secure_root_parent_for_new_path "$OUTPUT_PATH" "output"
secure_root_parent_for_new_path "$EVIDENCE_PATH" "raw evidence"
secure_root_parent_for_new_path "$RESULT_EVIDENCE_PATH" "runner result evidence"
secure_runner_directory "$RUNNER_STORAGE_ROOT" "runner storage root"
secure_root_executable "$OCI_RUNTIME_PATH" "OCI runtime"
secure_root_executable "$CONMON_PATH" "conmon"
getent passwd "$RUNNER_UID" >/dev/null || die "runner UID does not exist"
getent group "$RUNNER_GID" >/dev/null || die "runner GID does not exist"
if pgrep -u "$RUNNER_UID" >/dev/null 2>&1; then
  die "dedicated runner UID already owns a process"
fi

ACTUAL_PLAN_DIGEST="sha256:$(sha256sum -- "$PLAN_PATH" | awk '{print $1}')"
[[ $ACTUAL_PLAN_DIGEST == "$EXPECTED_PLAN_DIGEST" ]] || die "plan bytes do not match the trusted digest"

PROFILE=$(jq -er '.profile' "$PLAN_PATH")
JOB_ID=$(jq -er '.job.id' "$PLAN_PATH")
PLAN_EXPIRES_AT=$(jq -er '.job.expiresAt' "$PLAN_PATH")
RESOLUTION_EXPIRES_AT=$(jq -er '[.egress.install.destinations[].resolutionExpiresAt] | min' "$PLAN_PATH")
PLAN_IMAGE_DIGEST=$(jq -er '.imageDigest' "$PLAN_PATH")
SOURCE_DIGEST=$(jq -er '.inputs.sourceArchiveDigest' "$PLAN_PATH")
EGRESS_POLICY_DIGEST=$(jq -er '.egress.install.policyDigest' "$PLAN_PATH")

[[ $PROFILE == disposable-egress-filtered-pilot-v1 ]] || die "plan profile is unsupported"
[[ $JOB_ID == "$CONTROL_JOB_ID" ]] || die "control-plane and plan job identities differ"
[[ $PLAN_IMAGE_DIGEST == "${RUNNER_IMAGE##*@}" ]] || die "runner image digest does not match the plan"
[[ $SOURCE_DIGEST =~ ^sha256:[a-f0-9]{64}$ ]] || die "source digest is invalid"
[[ $EGRESS_POLICY_DIGEST =~ ^sha256:[a-f0-9]{64}$ ]] || die "egress policy digest is invalid"
[[ $PLAN_EXPIRES_AT =~ ^[1-9][0-9]*$ ]] || die "plan expiry is invalid"
[[ $RESOLUTION_EXPIRES_AT =~ ^[1-9][0-9]*$ ]] || die "resolution expiry is invalid"
NOW_MS=$(date +%s%3N)
(( NOW_MS < PLAN_EXPIRES_AT )) || die "plan is expired"
(( RESOLUTION_EXPIRES_AT >= PLAN_EXPIRES_AT )) || die "resolution expires before the plan"
RUN_DEADLINE_MS=$PLAN_EXPIRES_AT
DEADLINE_RESERVE_MS=15000
(( RUN_DEADLINE_MS - NOW_MS >= 30000 )) || die "plan has insufficient remaining lifetime"
TABLE="api_migrator_${JOB_ID:11:16}"
[[ $TABLE =~ ^[a-z0-9_]+$ ]] || die "derived nftables table name is invalid"
MAIN_PID=$$
WATCHDOG_PID=
WORKSPACE=
WORKSPACE_MOUNTED=0

delete_nft_table() {
  if nft list table inet "$TABLE" >/dev/null 2>&1; then
    nft delete table inet "$TABLE" >/dev/null 2>&1
  fi
}

early_cleanup() {
  local original_status=$? unmounted=0
  trap - EXIT INT TERM HUP
  set +e
  if [[ $WATCHDOG_PID =~ ^[1-9][0-9]*$ ]]; then
    kill "$WATCHDOG_PID" >/dev/null 2>&1
    wait "$WATCHDOG_PID" >/dev/null 2>&1
  fi
  delete_nft_table
  if (( WORKSPACE_MOUNTED == 1 )); then
    umount -- "$WORKSPACE" >/dev/null 2>&1
    unmounted=$?
  fi
  if (( unmounted == 0 )) && [[ $WORKSPACE == /var/tmp/api-migrator-preview.* && -d $WORKSPACE ]]; then
    rm -rf -- "$WORKSPACE"
  fi
  exit "$original_status"
}
trap early_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# This guard starts before plan-shape validation and staging. It revokes the
# nftables table before signalling the foreground shell. systemd RuntimeMaxSec
# is still required as the independent final kill/cleanup boundary.
(
  remaining_ms=$((RUN_DEADLINE_MS - $(date +%s%3N)))
  if (( remaining_ms > 0 )); then sleep "$((remaining_ms / 1000))"; fi
  timeout 2 nft delete table inet "$TABLE" >/dev/null 2>&1 || true
  kill -TERM "$MAIN_PID" >/dev/null 2>&1 || true
) &
WATCHDOG_PID=$!

# Hashing a large or stalled source is now inside both the plan watchdog and
# the required systemd RuntimeMaxSec boundary.
[[ "sha256:$(sha256sum -- "$SOURCE_PATH" | awk '{print $1}')" == "$SOURCE_DIGEST" ]] \
  || die "source archive digest does not match"

phase_timeout_seconds() {
  local requested=$1 now_ms remaining_ms seconds
  now_ms=$(date +%s%3N)
  remaining_ms=$((RUN_DEADLINE_MS - now_ms - DEADLINE_RESERVE_MS))
  (( remaining_ms >= 1000 )) || die "runner deadline has no safe execution budget"
  seconds=$((remaining_ms / 1000))
  if (( seconds > requested )); then seconds=$requested; fi
  printf '%s' "$seconds"
}

assert_no_extended_metadata() {
  python3 -I -S - "$@" <<'PY'
import os
import sys

for root in sys.argv[1:]:
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        for path in [directory, *(os.path.join(directory, name) for name in [*names, *files])]:
            if os.path.islink(path) or os.listxattr(path, follow_symlinks=False):
                raise SystemExit(1)
PY
}

normalized_tree_digest() {
  python3 -I -S - "$1" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
digest = hashlib.sha256()
total_bytes = 0
entries = 0
for directory, names, files in os.walk(root, topdown=True, followlinks=False):
    names.sort(key=os.fsencode)
    files.sort(key=os.fsencode)
    relative_dir = os.path.relpath(directory, root)
    depth = 0 if relative_dir == "." else len(relative_dir.split(os.sep))
    if depth > 64 or os.listxattr(directory, follow_symlinks=False):
        raise SystemExit(1)
    for name in [*names, *files]:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root)
        info = os.lstat(path)
        entries += 1
        if entries > 50_000 or os.listxattr(path, follow_symlinks=False):
            raise SystemExit(1)
        encoded = os.fsencode(relative)
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISDIR(info.st_mode):
            if mode != 0o700:
                raise SystemExit(1)
            kind = b"d"
            size = 0
        elif stat.S_ISREG(info.st_mode):
            if mode not in (0o600, 0o700) or info.st_nlink != 1 or info.st_size > 268_435_456:
                raise SystemExit(1)
            kind = b"x" if info.st_mode & 0o111 else b"f"
            size = info.st_size
            total_bytes += size
            if total_bytes > 536_870_912:
                raise SystemExit(1)
        else:
            raise SystemExit(1)
        digest.update(kind + len(encoded).to_bytes(4, "big") + encoded + size.to_bytes(8, "big"))
        if kind in (b"f", b"x"):
            with open(path, "rb", buffering=0) as handle:
                while chunk := handle.read(1_048_576):
                    digest.update(chunk)
print(f"sha256:{digest.hexdigest()}")
PY
}

jq -e '
  .schemaVersion == 1 and
  .job.disposable == true and
  .execution.credentials == "none" and
  .execution.rootlessContainer == true and
  .execution.readOnlyRoot == true and
  .execution.capabilities == "none" and
  .execution.noNewPrivileges == true and
  .execution.proxyEnvironment == "absent" and
  .execution.repositoryCodeExecution == true and
  .execution.sourceReadOnly == true and
  .execution.writableOutput == "bounded_tmpfs_then_root_sealed_transfer" and
  .execution.dependencyLifecycleScripts == "disabled" and
  .execution.onlinePhase == "dependency_install_only" and
  .execution.phaseOrder == ["offline_preparation", "dependency_install", "migration", "verification"] and
  .execution.checksNetwork == "none" and
  .execution.requiredChecks == ["install", "typecheck", "test", "lint", "runtime"] and
  .execution.outputBinding == "signed_attestation_reviewed_output" and
  .execution.storage == {
    "enforcement":"bounded_tmpfs",
    "workspaceBytes":1073741824,
    "workspaceInodes":200000,
    "maxLogBytesPerPhase":10485760,
    "maxRunnerEvidenceBytes":98304,
    "maxOutputBytes":536870912,
    "maxOutputFileBytes":268435456,
    "maxOutputEntries":50000,
    "maxOutputDepth":64
  } and
  .egress.enforcement == "host_nftables_output_exact_ip_tcp443" and
  .egress.dnsInsideJob == "disabled" and
  .egress.checks.network == "none" and
  (.egress.install.destinations | length) == 1 and
  .egress.install.destinations[0].host == "registry.npmjs.org" and
  .egress.install.destinations[0].protocol == "tcp" and
  .egress.install.destinations[0].port == 443 and
  .egress.install.destinations[0].tls == true and
  .egress.install.applicationLayerEnforcement == "external_l7_gateway_required"
' "$PLAN_PATH" >/dev/null || die "plan does not contain the fixed execution controls"

mapfile -t ALLOWED_ADDRESSES < <(jq -er '.egress.install.destinations[0].addresses[]' "$PLAN_PATH")
(( ${#ALLOWED_ADDRESSES[@]} > 0 && ${#ALLOWED_ADDRESSES[@]} <= 32 )) || die "allowlisted address set is invalid"
IPV4=()
IPV6=()
for address in "${ALLOWED_ADDRESSES[@]}"; do
  read -r version global canonical < <(python3 -I -S -c 'import ipaddress,sys; ip=ipaddress.ip_address(sys.argv[1]); print(ip.version, ip.is_global, str(ip))' "$address") \
    || die "allowlisted destination is not an exact IP literal"
  [[ $address != *%* && $address != */* ]] || die "scoped or CIDR destinations are forbidden"
  [[ $global == True ]] || die "allowlisted destination must be global unicast"
  [[ $canonical == "$address" ]] || die "allowlisted destination must use canonical IP text"
  if [[ $version == 4 ]]; then IPV4+=("$address"); else IPV6+=("$address"); fi
done
[[ $(printf '%s\n' "${ALLOWED_ADDRESSES[@]}" | sort -u | wc -l) -eq ${#ALLOWED_ADDRESSES[@]} ]] \
  || die "allowlisted destination set contains duplicates"

SCRIPT_DIR=$(dirname -- "$WRAPPER_PATH")
TEMPLATE_PATH="$SCRIPT_DIR/nftables-egress.nft.in"
secure_root_file "$TEMPLATE_PATH" "nftables template"

WORKSPACE=$(mktemp -d /var/tmp/api-migrator-preview.XXXXXXXX)
[[ $WORKSPACE == /var/tmp/api-migrator-preview.* && $WORKSPACE != /var/tmp ]] || die "private workspace creation failed"
chown root:"$RUNNER_GID" -- "$WORKSPACE"
chmod 0710 "$WORKSPACE"
mount -t tmpfs -o "size=1073741824,nr_inodes=200000,nosuid,nodev,mode=0710,uid=0,gid=$RUNNER_GID" \
  tmpfs "$WORKSPACE"
WORKSPACE_MOUNTED=1
STAGED_PLAN="$WORKSPACE/plan.json"
STAGED_SOURCE="$WORKSPACE/source.tar"
JOB_OUTPUT_DIR="$WORKSPACE/output"
DEPENDENCY_DIR="$WORKSPACE/dependencies"
INSTALLATION_DIR="$WORKSPACE/installation"
RESULT_DIR="$WORKSPACE/result"
POLICY_PATH="$WORKSPACE/egress.nft"
PREPARE_LOG="$WORKSPACE/prepare.log"
INSTALL_LOG="$WORKSPACE/install.log"
MIGRATE_LOG="$WORKSPACE/migrate.log"
VERIFY_LOG="$WORKSPACE/verify.log"
JOB_HOME="$WORKSPACE/host-home"
JOB_XDG_RUNTIME="$WORKSPACE/xdg-runtime"
JOB_XDG_CONFIG="$WORKSPACE/xdg-config"
PODMAN_RUNROOT="$WORKSPACE/podman-runroot"
PODMAN_TMP="$WORKSPACE/podman-tmp"
PODMAN_HOOKS_DIR="$WORKSPACE/empty-hooks"
CONTAINERS_CONF_PATH="$JOB_XDG_CONFIG/containers.conf"
STORAGE_CONF_PATH="$JOB_XDG_CONFIG/storage.conf"
REGISTRIES_CONF_PATH="$JOB_XDG_CONFIG/registries.conf"
MOUNTS_CONF_PATH="$JOB_XDG_CONFIG/mounts.conf"
SIGNATURE_POLICY_PATH="$JOB_XDG_CONFIG/policy.json"
# Only the dedicated runner group can traverse the bounded root-owned tmpfs or
# read its immutable inputs. Writable paths are separate dedicated directories.
install -o root -g "$RUNNER_GID" -m 0440 -- "$PLAN_PATH" "$STAGED_PLAN"
install -o root -g "$RUNNER_GID" -m 0440 -- "$SOURCE_PATH" "$STAGED_SOURCE"
install -d -o "$RUNNER_UID" -g "$RUNNER_GID" -m 0700 -- \
  "$JOB_OUTPUT_DIR" "$DEPENDENCY_DIR" "$INSTALLATION_DIR" "$RESULT_DIR" "$JOB_HOME" \
  "$JOB_XDG_RUNTIME" "$PODMAN_RUNROOT" "$PODMAN_TMP"
install -d -o root -g "$RUNNER_GID" -m 0550 -- "$JOB_XDG_CONFIG" "$PODMAN_HOOKS_DIR"
install -o root -g "$RUNNER_GID" -m 0440 /dev/null \
  "$CONTAINERS_CONF_PATH" "$MOUNTS_CONF_PATH"
printf 'unqualified-search-registries = []\n' >"$REGISTRIES_CONF_PATH"
printf '[storage]\ndriver = "%s"\nrunroot = "%s"\ngraphroot = "%s"\n' \
  "$RUNNER_STORAGE_DRIVER" "$PODMAN_RUNROOT" "$RUNNER_STORAGE_ROOT" >"$STORAGE_CONF_PATH"
printf '%s' '{"default":[{"type":"insecureAcceptAnything"}],"transports":{}}' \
  >"$SIGNATURE_POLICY_PATH"
chown root:"$RUNNER_GID" -- \
  "$REGISTRIES_CONF_PATH" "$STORAGE_CONF_PATH" "$SIGNATURE_POLICY_PATH"
chmod 0440 -- "$REGISTRIES_CONF_PATH" "$STORAGE_CONF_PATH" "$SIGNATURE_POLICY_PATH"
install -o root -g root -m 0600 /dev/null "$EVIDENCE_PATH"
exec 3>"$EVIDENCE_PATH"

PREPARE_CONTAINER="${JOB_ID:0:54}-prepare"
INSTALL_CONTAINER="${JOB_ID:0:54}-install"
MIGRATE_CONTAINER="${JOB_ID:0:54}-migrate"
VERIFY_CONTAINER="${JOB_ID:0:54}-verify"
OUTPUT_CREATED=0
CLEANUP_COMPLETE=0

PODMAN_GLOBAL_ARGS=(
  --root="$RUNNER_STORAGE_ROOT"
  --runroot="$PODMAN_RUNROOT"
  --storage-driver="$RUNNER_STORAGE_DRIVER"
  --runtime="$OCI_RUNTIME_PATH"
  --conmon="$CONMON_PATH"
  --events-backend=none
  --cgroup-manager=cgroupfs
  --tmpdir="$PODMAN_TMP"
)

event() {
  local name=$1 detail=${2:-}
  jq -cn \
    --arg event "$name" \
    --arg detail "$detail" \
    --arg jobId "$JOB_ID" \
    --arg planDigest "$EXPECTED_PLAN_DIGEST" \
    --arg systemdInvocation "$INVOCATION_ID" \
    --argjson observedAt "$(date +%s%3N)" \
    '{event:$event,detail:$detail,jobId:$jobId,planDigest:$planDigest,systemdInvocation:$systemdInvocation,observedAt:$observedAt}' >&3
}

run_as_job() {
  setpriv --reuid="$RUNNER_UID" --regid="$RUNNER_GID" --clear-groups \
    env -i \
      HOME="$JOB_HOME" \
      USER="api-migrator-job" \
      LOGNAME="api-migrator-job" \
      XDG_RUNTIME_DIR="$JOB_XDG_RUNTIME" \
      XDG_CONFIG_HOME="$JOB_XDG_CONFIG" \
      TMPDIR="$PODMAN_TMP" \
      CONTAINERS_TMPDIR="$PODMAN_TMP" \
      CONTAINERS_CONF="$CONTAINERS_CONF_PATH" \
      CONTAINERS_STORAGE_CONF="$STORAGE_CONF_PATH" \
      CONTAINERS_REGISTRIES_CONF="$REGISTRIES_CONF_PATH" \
      CONTAINERS_MOUNTS_CONF="$MOUNTS_CONF_PATH" \
      CONTAINERS_POLICY="$SIGNATURE_POLICY_PATH" \
      PATH="$TRUSTED_PATH" \
      podman "${PODMAN_GLOBAL_ARGS[@]}" "$@"
}

cleanup() {
  local original_status=$? cleanup_status=0
  trap - EXIT INT TERM HUP
  set +e
  if [[ $WATCHDOG_PID =~ ^[1-9][0-9]*$ ]]; then
    kill "$WATCHDOG_PID" >/dev/null 2>&1
    wait "$WATCHDOG_PID" >/dev/null 2>&1
    WATCHDOG_PID=
  fi
  run_as_job rm --force --ignore "$PREPARE_CONTAINER" "$INSTALL_CONTAINER" "$MIGRATE_CONTAINER" "$VERIFY_CONTAINER" >/dev/null 2>&1
  [[ $? -eq 0 ]] || cleanup_status=1
  event "containers_destroyed" "status=$cleanup_status" || cleanup_status=1
  run_as_job system migrate >/dev/null 2>&1
  [[ $? -eq 0 ]] || cleanup_status=1
  event "podman_cleanup_observed" "status=$cleanup_status" || cleanup_status=1
  if nft list table inet "$TABLE" >/dev/null 2>&1; then
    delete_nft_table
    [[ $? -eq 0 ]] || cleanup_status=1
  fi
  if nft list table inet "$TABLE" >/dev/null 2>&1; then cleanup_status=1; fi
  event "nftables_policy_removed" "status=$cleanup_status" || cleanup_status=1
  if (( OUTPUT_CREATED == 1 && CLEANUP_COMPLETE == 0 )); then
    if [[ $OUTPUT_PATH == /* && -d $OUTPUT_PATH && ! -L $OUTPUT_PATH ]]; then
      rm -rf -- "$OUTPUT_PATH"
      [[ $? -eq 0 ]] || cleanup_status=1
    else
      cleanup_status=1
    fi
  fi
  if (( WORKSPACE_MOUNTED == 1 )); then
    umount -- "$WORKSPACE" >/dev/null 2>&1
    if [[ $? -eq 0 ]]; then
      WORKSPACE_MOUNTED=0
    else
      cleanup_status=1
    fi
  fi
  if [[ $WORKSPACE == /var/tmp/api-migrator-preview.* && -d $WORKSPACE ]]; then
    if (( WORKSPACE_MOUNTED == 0 )); then
      rm -rf -- "$WORKSPACE"
      [[ $? -eq 0 ]] || cleanup_status=1
    else
      cleanup_status=1
    fi
  else
    cleanup_status=1
  fi
  event "workspace_destroyed" "status=$cleanup_status" || cleanup_status=1
  if (( original_status == 0 && cleanup_status == 0 && CLEANUP_COMPLETE == 1 )); then
    event "wrapper_teardown_complete" "raw-events-require-control-plane-signature" \
      || cleanup_status=1
  else
    event "wrapper_failed" "raw-events-must-not-be-signed" || cleanup_status=1
  fi
  sync -f -- "$EVIDENCE_PATH" >/dev/null 2>&1 || cleanup_status=1
  exec 3>&-
  if (( original_status != 0 )); then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

join_addresses() {
  local IFS=', '
  printf '%s' "$*"
}
IPV4_TEXT=$(join_addresses "${IPV4[@]}")
IPV6_TEXT=$(join_addresses "${IPV6[@]}")
sed \
  -e "s/@TABLE@/$TABLE/g" \
  -e "s/@UID@/$RUNNER_UID/g" \
  -e "s/@IPV4@/$IPV4_TEXT/g" \
  -e "s/@IPV6@/$IPV6_TEXT/g" \
  "$TEMPLATE_PATH" >"$POLICY_PATH"
if nft list table inet "$TABLE" >/dev/null 2>&1; then
  die "derived nftables table already exists"
fi
nft -c -f "$POLICY_PATH" >/dev/null || die "rendered nftables policy is invalid"
nft -f "$POLICY_PATH"
RULESET_DIGEST="sha256:$(nft -j list table inet "$TABLE" | sha256sum | awk '{print $1}')"
event "nftables_policy_installed" "$RULESET_DIGEST"

ROOTLESS=$(run_as_job info --format '{{.Host.Security.Rootless}}')
[[ $ROOTLESS == true ]] || die "Podman is not operating rootlessly for the dedicated UID"
run_as_job image exists "$RUNNER_IMAGE" || die "digest-pinned runner image is not preloaded"
INSPECTED_IMAGE_DIGEST=$(run_as_job image inspect --format '{{.Digest}}' "$RUNNER_IMAGE")
[[ $INSPECTED_IMAGE_DIGEST == "$PLAN_IMAGE_DIGEST" ]] || die "local runner image digest does not match the plan"
IMAGE_CONFIG_JSON=$(run_as_job image inspect --format '{{json .Config}}' "$RUNNER_IMAGE")
jq -e '
  ((.Env // []) == [] or (.Env // []) == ["PATH=/usr/local/bin:/usr/bin:/bin"]) and
  ((.Entrypoint // []) == []) and
  ((.Cmd // []) == []) and
  ((.Volumes == null) or (.Volumes == {})) and
  ((.User // "") == "" or (.User // "") == "0" or (.User // "") == "root") and
  ((.WorkingDir // "") == "" or (.WorkingDir // "") == "/") and
  ((.Healthcheck == null) or (.Healthcheck == {})) and
  ((.Shell // []) == [])
' <<<"$IMAGE_CONFIG_JSON" >/dev/null \
  || die "runner image contains unapproved runtime defaults"

COMMON_ARGS=(
  run --rm --pull=never --read-only --cap-drop=all
  --security-opt=no-new-privileges --pids-limit=256 --memory=2g --cpus=2
  --userns=keep-id --user="$RUNNER_UID:$RUNNER_GID" --workdir=/run/api-migrator
  --entrypoint=/usr/local/bin/api-migrator-runner
  --unsetenv-all --env=HOME=/tmp/job-home --env=PATH=/usr/local/bin:/usr/bin:/bin
  --http-proxy=false --systemd=false --stop-signal=TERM --stop-timeout=5
  --log-driver=none --image-volume=ignore --read-only-tmpfs=false
  --mounts-file="$MOUNTS_CONF_PATH" --hooks-dir="$PODMAN_HOOKS_DIR"
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=536870912
  --tmpfs="/npm-cache:rw,noexec,nosuid,nodev,size=268435456,mode=0700,uid=$RUNNER_UID,gid=$RUNNER_GID"
  --volume="$STAGED_PLAN:/run/api-migrator/plan.json:ro"
)
ADD_HOST_ARGS=()
for address in "${ALLOWED_ADDRESSES[@]}"; do
  ADD_HOST_ARGS+=(--add-host="registry.npmjs.org:$address")
done

event "offline_preparation_started" "network-none+read-only-source"
PREPARE_TIMEOUT=$(phase_timeout_seconds 300)
set +e
timeout --signal=TERM --kill-after=5 "$PREPARE_TIMEOUT" \
  setpriv --reuid="$RUNNER_UID" --regid="$RUNNER_GID" --clear-groups \
  env -i HOME="$JOB_HOME" USER=api-migrator-job LOGNAME=api-migrator-job \
    XDG_RUNTIME_DIR="$JOB_XDG_RUNTIME" XDG_CONFIG_HOME="$JOB_XDG_CONFIG" \
    TMPDIR="$PODMAN_TMP" CONTAINERS_TMPDIR="$PODMAN_TMP" \
    CONTAINERS_CONF="$CONTAINERS_CONF_PATH" CONTAINERS_STORAGE_CONF="$STORAGE_CONF_PATH" \
    CONTAINERS_REGISTRIES_CONF="$REGISTRIES_CONF_PATH" \
    CONTAINERS_MOUNTS_CONF="$MOUNTS_CONF_PATH" CONTAINERS_POLICY="$SIGNATURE_POLICY_PATH" \
    PATH="$TRUSTED_PATH" \
  podman "${PODMAN_GLOBAL_ARGS[@]}" "${COMMON_ARGS[@]}" \
    --name="$PREPARE_CONTAINER" \
    --network=none \
    --volume="$STAGED_SOURCE:/run/api-migrator/source.tar:ro" \
    --volume="$DEPENDENCY_DIR:/run/api-migrator/dependencies:rw" \
    --volume="$INSTALLATION_DIR:/run/api-migrator/installation:rw" \
    "$RUNNER_IMAGE" \
    prepare \
      --plan /run/api-migrator/plan.json \
      --source /run/api-migrator/source.tar \
      --dependencies /run/api-migrator/dependencies \
      --installation /run/api-migrator/installation \
  2>&1 | head -c 10485761 >"$PREPARE_LOG"
PREPARE_STATUS=("${PIPESTATUS[@]}")
set -e
[[ ${PREPARE_STATUS[0]} -eq 0 && ${PREPARE_STATUS[1]} -eq 0 ]] \
  || die "offline preparation container failed, timed out, or exceeded log capture"
[[ $(stat -Lc '%s' "$PREPARE_LOG") -le 10485760 ]] \
  || die "preparation log exceeded the evidence bound"
[[ $(wc -l <"$PREPARE_LOG") -eq 1 ]] \
  || die "offline preparation did not emit exactly one trusted status line"
PREPARE_LINE=$(<"$PREPARE_LOG")
if [[ $PREPARE_LINE =~ ^runner_phase=prepare\ status=passed\ prepared_state_digest=(sha256:[a-f0-9]{64})$ ]]; then
  PREPARED_STATE_DIGEST=${BASH_REMATCH[1]}
else
  die "offline preparation emitted an invalid trusted status line"
fi
event "offline_preparation_finished" "sha256:$(sha256sum "$PREPARE_LOG" | awk '{print $1}')"

event "dependency_install_started" "$EGRESS_POLICY_DIGEST"
INSTALL_TIMEOUT=$(phase_timeout_seconds 300)
set +e
timeout --signal=TERM --kill-after=5 "$INSTALL_TIMEOUT" \
  setpriv --reuid="$RUNNER_UID" --regid="$RUNNER_GID" --clear-groups \
  env -i HOME="$JOB_HOME" USER=api-migrator-job LOGNAME=api-migrator-job \
    XDG_RUNTIME_DIR="$JOB_XDG_RUNTIME" XDG_CONFIG_HOME="$JOB_XDG_CONFIG" \
    TMPDIR="$PODMAN_TMP" CONTAINERS_TMPDIR="$PODMAN_TMP" \
    CONTAINERS_CONF="$CONTAINERS_CONF_PATH" CONTAINERS_STORAGE_CONF="$STORAGE_CONF_PATH" \
    CONTAINERS_REGISTRIES_CONF="$REGISTRIES_CONF_PATH" \
    CONTAINERS_MOUNTS_CONF="$MOUNTS_CONF_PATH" CONTAINERS_POLICY="$SIGNATURE_POLICY_PATH" \
    PATH="$TRUSTED_PATH" \
  podman "${PODMAN_GLOBAL_ARGS[@]}" "${COMMON_ARGS[@]}" \
    --name="$INSTALL_CONTAINER" \
    --network=slirp4netns:allow_host_loopback=false \
    "${ADD_HOST_ARGS[@]}" \
    --volume="$INSTALLATION_DIR:/run/api-migrator/installation:rw" \
    "$RUNNER_IMAGE" \
    install \
      --plan /run/api-migrator/plan.json \
      --installation /run/api-migrator/installation \
      --prepared-state-digest "$PREPARED_STATE_DIGEST" \
  2>&1 | head -c 10485761 >"$INSTALL_LOG"
INSTALL_STATUS=("${PIPESTATUS[@]}")
set -e
[[ ${INSTALL_STATUS[0]} -eq 0 && ${INSTALL_STATUS[1]} -eq 0 ]] \
  || die "dependency install container failed, timed out, or exceeded log capture"
[[ $(stat -Lc '%s' "$INSTALL_LOG") -le 10485760 ]] || die "dependency install log exceeded the evidence bound"
[[ $(wc -l <"$INSTALL_LOG") -eq 1 ]] \
  || die "dependency installation did not emit exactly one trusted status line"
INSTALL_LINE=$(<"$INSTALL_LOG")
if [[ $INSTALL_LINE =~ ^runner_phase=install\ status=passed\ prepared_state_digest=(sha256:[a-f0-9]{64})\ install_state_digest=(sha256:[a-f0-9]{64})$ ]]; then
  [[ ${BASH_REMATCH[1]} == "$PREPARED_STATE_DIGEST" ]] \
    || die "dependency installation did not bind the offline prepared state"
  INSTALL_STATE_DIGEST=${BASH_REMATCH[2]}
else
  die "dependency installation emitted an invalid trusted status line"
fi
event "dependency_install_finished" "sha256:$(sha256sum "$INSTALL_LOG" | awk '{print $1}')"

# No migration or repository-controlled check runs until both network controls
# are closed. The online entrypoint is limited to lifecycle-disabled dependency
# acquisition implemented by the trusted, digest-pinned image.
nft flush set inet "$TABLE" allowed_v4
nft flush set inet "$TABLE" allowed_v6
event "offline_network_enforced" "podman-network-none+nft-empty-sets"

event "offline_migration_started" "network-none+read-only-source"
MIGRATE_TIMEOUT=$(phase_timeout_seconds 300)
set +e
timeout --signal=TERM --kill-after=5 "$MIGRATE_TIMEOUT" \
  setpriv --reuid="$RUNNER_UID" --regid="$RUNNER_GID" --clear-groups \
  env -i HOME="$JOB_HOME" USER=api-migrator-job LOGNAME=api-migrator-job \
    XDG_RUNTIME_DIR="$JOB_XDG_RUNTIME" XDG_CONFIG_HOME="$JOB_XDG_CONFIG" \
    TMPDIR="$PODMAN_TMP" CONTAINERS_TMPDIR="$PODMAN_TMP" \
    CONTAINERS_CONF="$CONTAINERS_CONF_PATH" CONTAINERS_STORAGE_CONF="$STORAGE_CONF_PATH" \
    CONTAINERS_REGISTRIES_CONF="$REGISTRIES_CONF_PATH" \
    CONTAINERS_MOUNTS_CONF="$MOUNTS_CONF_PATH" CONTAINERS_POLICY="$SIGNATURE_POLICY_PATH" \
    PATH="$TRUSTED_PATH" \
  podman "${PODMAN_GLOBAL_ARGS[@]}" "${COMMON_ARGS[@]}" \
    --name="$MIGRATE_CONTAINER" \
    --network=none \
    --volume="$STAGED_SOURCE:/run/api-migrator/source.tar:ro" \
    --volume="$DEPENDENCY_DIR:/run/api-migrator/dependencies:rw" \
    --volume="$INSTALLATION_DIR:/run/api-migrator/installation:ro" \
    --volume="$JOB_OUTPUT_DIR:/run/api-migrator/output:rw" \
    "$RUNNER_IMAGE" \
    migrate \
      --plan /run/api-migrator/plan.json \
      --source /run/api-migrator/source.tar \
      --dependencies /run/api-migrator/dependencies \
      --installation /run/api-migrator/installation \
      --prepared-state-digest "$PREPARED_STATE_DIGEST" \
      --install-state-digest "$INSTALL_STATE_DIGEST" \
      --output /run/api-migrator/output \
  2>&1 | head -c 10485761 >"$MIGRATE_LOG"
MIGRATE_STATUS=("${PIPESTATUS[@]}")
set -e
[[ ${MIGRATE_STATUS[0]} -eq 0 && ${MIGRATE_STATUS[1]} -eq 0 ]] \
  || die "offline migration container failed, timed out, or exceeded log capture"
[[ $(stat -Lc '%s' "$MIGRATE_LOG") -le 10485760 ]] || die "migration log exceeded the evidence bound"
[[ $(wc -l <"$MIGRATE_LOG") -eq 1 ]] \
  || die "offline migration did not emit exactly one trusted status line"
MIGRATE_LINE=$(<"$MIGRATE_LOG")
if [[ $MIGRATE_LINE =~ ^runner_phase=migrate\ status=passed\ dependency_state_digest=(sha256:[a-f0-9]{64})$ ]]; then
  DEPENDENCY_STATE_DIGEST=${BASH_REMATCH[1]}
else
  die "offline migration emitted an invalid trusted status line"
fi
event "offline_migration_finished" "sha256:$(sha256sum "$MIGRATE_LOG" | awk '{print $1}')"

event "offline_verification_started" "typecheck,test,lint,runtime"
VERIFY_TIMEOUT=$(phase_timeout_seconds 300)
set +e
timeout --signal=TERM --kill-after=5 "$VERIFY_TIMEOUT" \
  setpriv --reuid="$RUNNER_UID" --regid="$RUNNER_GID" --clear-groups \
  env -i HOME="$JOB_HOME" USER=api-migrator-job LOGNAME=api-migrator-job \
    XDG_RUNTIME_DIR="$JOB_XDG_RUNTIME" XDG_CONFIG_HOME="$JOB_XDG_CONFIG" \
    TMPDIR="$PODMAN_TMP" CONTAINERS_TMPDIR="$PODMAN_TMP" \
    CONTAINERS_CONF="$CONTAINERS_CONF_PATH" CONTAINERS_STORAGE_CONF="$STORAGE_CONF_PATH" \
    CONTAINERS_REGISTRIES_CONF="$REGISTRIES_CONF_PATH" \
    CONTAINERS_MOUNTS_CONF="$MOUNTS_CONF_PATH" CONTAINERS_POLICY="$SIGNATURE_POLICY_PATH" \
    PATH="$TRUSTED_PATH" \
  podman "${PODMAN_GLOBAL_ARGS[@]}" "${COMMON_ARGS[@]}" \
    --name="$VERIFY_CONTAINER" \
    --network=none \
    --volume="$JOB_OUTPUT_DIR:/run/api-migrator/input:ro" \
    --volume="$DEPENDENCY_DIR:/run/api-migrator/dependencies:ro" \
    --volume="$RESULT_DIR:/run/api-migrator/result:rw" \
    "$RUNNER_IMAGE" \
    verify \
      --plan /run/api-migrator/plan.json \
      --input /run/api-migrator/input \
      --dependencies /run/api-migrator/dependencies \
      --dependency-state-digest "$DEPENDENCY_STATE_DIGEST" \
      --result /run/api-migrator/result \
  2>&1 | head -c 10485761 >"$VERIFY_LOG"
VERIFY_STATUS=("${PIPESTATUS[@]}")
set -e
[[ ${VERIFY_STATUS[0]} -eq 0 && ${VERIFY_STATUS[1]} -eq 0 ]] \
  || die "offline verification container failed, timed out, or exceeded log capture"
[[ $(stat -Lc '%s' "$VERIFY_LOG") -le 10485760 ]] || die "verification log exceeded the evidence bound"
[[ $(wc -l <"$VERIFY_LOG") -eq 1 ]] \
  || die "offline verification did not emit exactly one trusted status line"
VERIFY_LINE=$(<"$VERIFY_LOG")
if [[ $VERIFY_LINE =~ ^runner_phase=verify\ status=passed\ evidence_digest=(sha256:[a-f0-9]{64})\ preflight_id=(pf_[a-f0-9]{64})$ ]]; then
  REPORTED_EVIDENCE_DIGEST=${BASH_REMATCH[1]}
  REPORTED_PREFLIGHT_ID=${BASH_REMATCH[2]}
else
  die "offline verification emitted an invalid trusted status line"
fi
event "offline_checks_finished" "sha256:$(sha256sum "$VERIFY_LOG" | awk '{print $1}')"

# Stop the dedicated rootless engine and prove its OS identity is idle before
# revoking its ownership of every job-created tree. Special bits are rejected
# before chown so clearing them cannot masquerade as validation.
run_as_job system migrate >/dev/null 2>&1 || die "rootless Podman cleanup failed"
if pgrep -u "$RUNNER_UID" >/dev/null 2>&1; then
  die "runner UID still owns a process after verification"
fi
if find -P "$JOB_OUTPUT_DIR" -type l -print -quit | grep -q .; then
  die "runner output contains a symlink"
fi
if find -P "$JOB_OUTPUT_DIR" ! -type d ! -type f -print -quit | grep -q .; then
  die "runner output contains a non-regular object"
fi
if find -P "$JOB_OUTPUT_DIR" -perm /7000 -print -quit | grep -q .; then
  die "runner output contains setuid, setgid, or sticky mode bits"
fi
assert_no_extended_metadata "$JOB_OUTPUT_DIR" "$RESULT_DIR" \
  || die "runner output or evidence contains symlinks, ACLs, capabilities, or xattrs"
chown -R -h root:root -- "$JOB_OUTPUT_DIR" "$RESULT_DIR" "$DEPENDENCY_DIR" "$INSTALLATION_DIR"
chmod -R go-rwx -- "$JOB_OUTPUT_DIR" "$RESULT_DIR" "$DEPENDENCY_DIR" "$INSTALLATION_DIR"
find -P "$JOB_OUTPUT_DIR" -type d -exec chmod 0700 -- {} +
find -P "$JOB_OUTPUT_DIR" -type f -perm /0111 -exec chmod 0700 -- {} +
find -P "$JOB_OUTPUT_DIR" -type f ! -perm /0111 -exec chmod 0600 -- {} +
if pgrep -u "$RUNNER_UID" >/dev/null 2>&1; then
  die "runner UID reacquired a process during ownership revocation"
fi
SOURCE_TRANSFER_DIGEST=$(normalized_tree_digest "$JOB_OUTPUT_DIR") \
  || die "runner output exceeds its normalized metadata or content bounds"
event "output_ownership_revoked" "$SOURCE_TRANSFER_DIGEST"

RAW_RESULT="$RESULT_DIR/runner-evidence.json"
SAFE_RESULT="$WORKSPACE/runner-evidence.safe.json"
CANONICAL_RESULT="$WORKSPACE/runner-evidence.canonical.json"
[[ -f $RAW_RESULT && ! -L $RAW_RESULT ]] || die "runner did not emit bounded raw evidence"
[[ $(stat -Lc '%s' "$RAW_RESULT") -le 98304 ]] || die "runner raw evidence is too large"
install -o root -g root -m 0600 /dev/null "$CANONICAL_RESULT"
jq -cMSj '.' "$RAW_RESULT" >"$CANONICAL_RESULT" \
  || die "runner raw evidence is not valid JSON"
cmp -s -- "$RAW_RESULT" "$CANONICAL_RESULT" \
  || die "runner raw evidence is not exact canonical JSON"
RAW_RESULT_DIGEST="sha256:$(sha256sum "$RAW_RESULT" | awk '{print $1}')"
[[ $RAW_RESULT_DIGEST == "$REPORTED_EVIDENCE_DIGEST" ]] \
  || die "runner evidence file does not match the trusted verification status digest"
REPORT_DIGEST="sha256:$(jq -cMSj '.report' "$RAW_RESULT" | sha256sum | awk '{print $1}')"
jq -e \
  --arg planDigest "$EXPECTED_PLAN_DIGEST" \
  --arg jobId "$JOB_ID" \
  --arg sourceDigest "$SOURCE_DIGEST" \
  --arg manifestDigest "$(jq -er '.inputs.manifestDigest' "$PLAN_PATH")" \
  --arg commandScopeDigest "$(jq -er '.inputs.commandScopeDigest' "$PLAN_PATH")" \
  --arg dependencyStateDigest "$DEPENDENCY_STATE_DIGEST" \
  --arg reportDigest "$REPORT_DIGEST" '
  (keys | sort) == [
    "blockers", "checks", "commandScopeDigest", "dependencyStateDigest", "jobId", "kind",
    "manifestDigest", "output", "outputTreeDigest", "planDigest", "profile", "report",
    "reportDigest", "schemaVersion", "sourceArchiveDigest", "targetBranch"
  ] and
  .schemaVersion == 1 and
  .kind == "api-migrator-runner-evidence-v1" and
  .profile == "disposable-egress-filtered-pilot-v1" and
  .planDigest == $planDigest and
  .jobId == $jobId and
  .sourceArchiveDigest == $sourceDigest and
  .manifestDigest == $manifestDigest and
  .commandScopeDigest == $commandScopeDigest and
  .reportDigest == $reportDigest and
  .dependencyStateDigest == $dependencyStateDigest and
  (.outputTreeDigest | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
  (.targetBranch | type == "string" and length <= 240 and startswith("codex/api-migrator/")) and
  .blockers == [] and
  (.output | keys | sort) == ["artifactDigest", "candidateTreeSha", "preflightId"] and
  (.output.preflightId | type == "string" and test("^pf_[a-f0-9]{64}$")) and
  (.output.artifactDigest | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
  (.output.candidateTreeSha | type == "string" and test("^([a-f0-9]{40}|[a-f0-9]{64})$")) and
  (.checks | keys | sort) == ["install", "lint", "runtime", "test", "typecheck"] and
  all(.checks[];
    (.status == "passed") and (.exitCode == 0) and
    (.command | type == "string" and length > 0 and length <= 4096) and
    ((has("reason") | not) or (.reason | type == "string" and length <= 4096)) and
    ((keys | sort) == (["command", "exitCode", "status"] + (if has("reason") then ["reason"] else [] end) | sort))
  ) and
  (.report | type == "object") and
  .report.verification.ok == true and
  .report.verification.skipped == false and
  all(["install", "typecheck", "test", "lint", "runtime"][] as $name;
    .report.verification.checks[$name].status == .checks[$name].status and
    .report.verification.checks[$name].command == .checks[$name].command and
    .report.verification.checks[$name].exitCode == .checks[$name].exitCode and
    .report.verification.checks[$name].reason == .checks[$name].reason
  )
' "$RAW_RESULT" >/dev/null || die "runner raw evidence is incomplete, blocked, or inconsistent"
install -o root -g root -m 0600 -- "$CANONICAL_RESULT" "$SAFE_RESULT"
PREFLIGHT_ID=$(jq -er '.output.preflightId' "$RAW_RESULT")
[[ $PREFLIGHT_ID == "$REPORTED_PREFLIGHT_ID" ]] \
  || die "runner evidence preflight does not match the trusted verification status"
ARTIFACT_DIGEST=$(jq -er '.output.artifactDigest' "$RAW_RESULT")
CANDIDATE_TREE=$(jq -er '.output.candidateTreeSha' "$RAW_RESULT")
event "offline_verification_finished" "sha256:$(sha256sum "$SAFE_RESULT" | awk '{print $1}')"

install -o root -g root -m 0600 -- "$SAFE_RESULT" "$RESULT_EVIDENCE_PATH"
mkdir -- "$OUTPUT_PATH"
OUTPUT_CREATED=1
chown root:root -- "$OUTPUT_PATH"
chmod 0700 -- "$OUTPUT_PATH"
cp -R --no-preserve=ownership,timestamps,xattr,context,links -- \
  "$JOB_OUTPUT_DIR/." "$OUTPUT_PATH/"
chown -R root:root -- "$OUTPUT_PATH"
chmod -R go-w -- "$OUTPUT_PATH"
SEALED_TRANSFER_DIGEST=$(normalized_tree_digest "$OUTPUT_PATH") \
  || die "sealed output exceeds its normalized metadata or content bounds"
[[ $SEALED_TRANSFER_DIGEST == "$SOURCE_TRANSFER_DIGEST" ]] \
  || die "sealed output does not match the frozen runner output"
sync -f -- "$RESULT_EVIDENCE_PATH" || die "runner result evidence could not be durably synchronized"
sync -f -- "$OUTPUT_PATH" || die "sealed output could not be durably synchronized"
event "output_sealed" "$ARTIFACT_DIGEST"
(( $(date +%s%3N) < RUN_DEADLINE_MS )) || die "runner completed after its absolute deadline"
CLEANUP_COMPLETE=1
