#!/bin/bash -p
set -Eeuo pipefail
umask 077

readonly TRUSTED_PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH=$TRUSTED_PATH
hash -r

refuse() {
  printf 'runner cleanup refused: %s\n' "$1" >&2
  exit 1
}

command -v uname >/dev/null 2>&1 || refuse "uname is unavailable"
command -v awk >/dev/null 2>&1 || refuse "awk is unavailable"
command -v jq >/dev/null 2>&1 || refuse "jq is unavailable"
command -v nft >/dev/null 2>&1 || refuse "nft is unavailable"
command -v pgrep >/dev/null 2>&1 || refuse "pgrep is unavailable"
command -v ps >/dev/null 2>&1 || refuse "ps is unavailable"
command -v find >/dev/null 2>&1 || refuse "find is unavailable"
command -v readlink >/dev/null 2>&1 || refuse "readlink is unavailable"
command -v stat >/dev/null 2>&1 || refuse "stat is unavailable"

[[ $# -eq 1 ]] || refuse "one absolute job descriptor path is required"
[[ $(uname -s) == Linux && ${EUID} -eq 0 ]] || refuse "Linux root execution is required"
[[ ${INVOCATION_ID:-} =~ ^[a-f0-9]{32}$ ]] || refuse "systemd invocation identity is required"
descriptor=$1
[[ $descriptor == /* && -f $descriptor && ! -L $descriptor ]] \
  || refuse "job descriptor must be an absolute regular file"
[[ $(readlink -f -- "$descriptor") == "$descriptor" ]] \
  || refuse "job descriptor path must be canonical"

secure_root_file() {
  local path=$1 label=$2 mode owner
  owner=$(stat -Lc '%u' -- "$path")
  mode=$(stat -Lc '%a' -- "$path")
  [[ $owner == 0 ]] || refuse "$label must be root-owned"
  (( (8#$mode & 8#022) == 0 )) || refuse "$label must not be group/world writable"
}

secure_root_file "$descriptor" "job descriptor"

schema_version=$(jq -er '.schemaVersion' "$descriptor")
job_id=$(jq -er '.jobId' "$descriptor")
host_profile=$(jq -er '.hostProfilePath' "$descriptor")
[[ $schema_version == 2 ]] || refuse "job descriptor version is unsupported"
[[ $job_id =~ ^previewjob_[a-f0-9]{64}$ ]] || refuse "job identity is invalid"
[[ $host_profile == /* && -f $host_profile && ! -L $host_profile ]] \
  || refuse "host profile must be an absolute regular file"
[[ $(readlink -f -- "$host_profile") == "$host_profile" ]] \
  || refuse "host profile path must be canonical"
secure_root_file "$host_profile" "host profile"
runner_uid=$(jq -er '.runner.uid' "$host_profile")
gateway_uid=$(jq -er '.gateway.uid' "$host_profile")
subuid_start=$(jq -er '.runner.subuid.start' "$host_profile")
subuid_count=$(jq -er '.runner.subuid.count' "$host_profile")
[[ $runner_uid =~ ^[1-9][0-9]*$ ]] || refuse "runner UID is invalid"
[[ $gateway_uid =~ ^[1-9][0-9]*$ && $gateway_uid != "$runner_uid" ]] \
  || refuse "gateway UID is invalid or not distinct"
[[ $subuid_start =~ ^[1-9][0-9]*$ && $subuid_count =~ ^[1-9][0-9]*$ ]] \
  || refuse "runner subordinate UID range is invalid"
subuid_end=$((subuid_start + subuid_count - 1))
(( subuid_end >= subuid_start && subuid_end <= 2147483647 )) \
  || refuse "runner subordinate UID range overflows"

legacy_table="api_migrator_${job_id:11:16}"
gateway_table="api_migrator_gw_${job_id:11:16}"
[[ $legacy_table =~ ^api_migrator_[a-f0-9]{16}$ ]] \
  || refuse "legacy nftables table identity is invalid"
[[ $gateway_table =~ ^api_migrator_gw_[a-f0-9]{16}$ ]] \
  || refuse "gateway nftables table identity is invalid"

# KillMode=control-group must have removed job processes before ExecStopPost.
# This helper deliberately does not kill an arbitrary UID or delete broad
# paths. Containment remains installed until every job identity is idle and
# the private workspace is gone.
assert_job_boundary_idle() {
  local probe_status=0 process_snapshot subuid_state workspace_snapshot
  pgrep -u "$runner_uid" >/dev/null 2>&1 || probe_status=$?
  case $probe_status in
    0) refuse "dedicated runner UID still owns a process" ;;
    1) ;;
    *) refuse "dedicated runner UID could not be observed idle" ;;
  esac
  probe_status=0
  pgrep -u "$gateway_uid" >/dev/null 2>&1 || probe_status=$?
  case $probe_status in
    0) refuse "dedicated gateway UID still owns a process" ;;
    1) ;;
    *) refuse "dedicated gateway UID could not be observed idle" ;;
  esac
  # Capture each command separately: a failed producer or parser cannot become
  # the false condition of a pipeline and masquerade as an absent process.
  process_snapshot=$(ps -e -o uid=) \
    || refuse "process UID snapshot could not be observed"
  subuid_state=$(awk -v first="$subuid_start" -v last="$subuid_end" '
    NF != 1 || $1 !~ /^[0-9]+$/ { invalid = 1 }
    $1 >= first && $1 <= last { found = 1 }
    END { if (invalid || NR == 0) exit 2; print found ? "present" : "absent" }
  ' <<<"$process_snapshot") || refuse "process UID snapshot could not be validated"
  case $subuid_state in
    absent) ;;
    present) refuse "runner subordinate UID range still owns a process" ;;
    *) refuse "runner subordinate UID absence could not be observed" ;;
  esac
  workspace_snapshot=$(find /var/tmp -mindepth 1 -maxdepth 1 -type d \
    -name 'api-migrator-preview.*' -print -quit) \
    || refuse "preview workspace absence could not be observed"
  [[ -z $workspace_snapshot ]] || refuse "a preview workspace survived cleanup"
}

assert_job_boundary_idle

# A failed exact-table lookup also returns nonzero when the table is absent.
# Require a successful, well-formed complete inventory before interpreting it.
exact_table_present() {
  local snapshot table_state
  snapshot=$(nft -j list tables) || refuse "nftables table inventory could not be observed"
  table_state=$(jq -er --arg table "$1" '
    if type != "object" or keys != ["nftables"] or (.nftables | type) != "array" then
      error("invalid table inventory")
    elif all(.nftables[];
      type == "object" and (
        (keys == ["metainfo"] and (.metainfo | type) == "object") or
        (keys == ["table"] and (.table | type) == "object" and
          (.table.family | type == "string" and length > 0) and
          (.table.name | type == "string" and length > 0))
      )
    ) then
      any(.nftables[]; .table?.family == "inet" and .table?.name == $table) | tostring
    else error("invalid table inventory") end
  ' <<<"$snapshot") || refuse "nftables table inventory could not be validated"
  case $table_state in
    true) return 0 ;;
    false) return 1 ;;
    *) refuse "exact job nftables table absence could not be observed" ;;
  esac
}

# Remove the legacy L3 table first so the stronger forced-gateway containment
# remains installed until the last policy-removal step.
for table in "$legacy_table" "$gateway_table"; do
  if exact_table_present "$table"; then
    nft delete table inet "$table" >/dev/null 2>&1 \
      || refuse "exact job nftables table could not be removed"
  fi
  if exact_table_present "$table"; then
    refuse "exact job nftables table survived cleanup"
  fi
done

# Detect an unexpected process/workspace race after policy removal. Dedicated
# identities are provisioned without interactive login; any reappearance is a
# host incident even though the pre-removal check preserved containment.
assert_job_boundary_idle
