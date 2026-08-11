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
command -v grep >/dev/null 2>&1 || refuse "grep is unavailable"
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
  if pgrep -u "$runner_uid" >/dev/null 2>&1; then
    refuse "dedicated runner UID still owns a process"
  fi
  if pgrep -u "$gateway_uid" >/dev/null 2>&1; then
    refuse "dedicated gateway UID still owns a process"
  fi
  if ps -e -o uid= | awk -v first="$subuid_start" -v last="$subuid_end" \
    '$1 >= first && $1 <= last { found = 1 } END { exit found ? 0 : 1 }'; then
    refuse "runner subordinate UID range still owns a process"
  fi
  if find /var/tmp -mindepth 1 -maxdepth 1 -type d -name 'api-migrator-preview.*' -print -quit | grep -q .; then
    refuse "a preview workspace survived cleanup"
  fi
}

assert_job_boundary_idle

# Remove the legacy L3 table first so the stronger forced-gateway containment
# remains installed until the last policy-removal step.
for table in "$legacy_table" "$gateway_table"; do
  if nft list table inet "$table" >/dev/null 2>&1; then
    nft delete table inet "$table" >/dev/null 2>&1 \
      || refuse "exact job nftables table could not be removed"
  fi
  if nft list table inet "$table" >/dev/null 2>&1; then
    refuse "exact job nftables table survived cleanup"
  fi
done

# Detect an unexpected process/workspace race after policy removal. Dedicated
# identities are provisioned without interactive login; any reappearance is a
# host incident even though the pre-removal check preserved containment.
assert_job_boundary_idle
