import { createHash } from "node:crypto";
import { canonicalJson } from "../publication-runner/deployment/lib.mjs";

const PROJECT = "project-32bf49a2-bd30-4956-850";
const ZONE = "us-central1-a";
const REGION = "us-central1";
const SHA256 = /^[a-f0-9]{64}$/;
const NETWORK = /^api-migrator-trial-[a-z0-9](?:[a-z0-9-]{0,42}[a-z0-9])?$/;
const RUNTIME = Object.freeze({ version: "22.23.2", platform: "linux-x64",
  url: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
  sha256: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307" });
const REQUEST_KEYS = ["projectId", "runId", "sourceRevision", "sourceArchiveSha256", "bootImage",
  "network", "subnetwork", "egress", "startupScriptSha256", "deleteAt"];

function exactFields(input, keys) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("invalid or unknown input fields");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) {
    throw new TypeError("invalid or unknown input fields");
  }
  // Validate and render the same primitive data values, never caller getters.
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function project(value) {
  if (value !== PROJECT) throw new TypeError("project scope invalid");
}
function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}
function matches(pattern, value) { return typeof value === "string" && pattern.test(value); }
function command(...args) {
  // Do not inherit a professional resource/quota project from gcloud defaults.
  return ["gcloud", ...args, `--project=${PROJECT}`, `--billing-project=${PROJECT}`, "--format=json"];
}

export function renderTrialPlan(input, { nowMs = Date.now() } = {}) {
  input = exactFields(input, REQUEST_KEYS);
  project(input.projectId);
  if (!timestamp(nowMs)) throw new TypeError("planner clock invalid");
  if (!timestamp(input.deleteAt) || input.deleteAt - nowMs < 900_000 || input.deleteAt - nowMs > 3_600_000) {
    throw new TypeError("trial deadline invalid; require 15-60 minutes remaining");
  }
  if (!matches(/^[a-f0-9]{32}$/, input.runId) || !matches(/^[a-f0-9]{40}$/, input.sourceRevision)
    || !matches(SHA256, input.sourceArchiveSha256) || !matches(SHA256, input.startupScriptSha256)
    || !matches(/^debian-12-bookworm-v[0-9]{8}$/, input.bootImage)
    || !matches(NETWORK, input.network) || !matches(NETWORK, input.subnetwork)
    || !["existing-nat", "ephemeral-external-ip"].includes(input.egress)) {
    throw new TypeError("trial immutable inputs or network declaration invalid");
  }
  const instanceName = `api-migrator-trial-${input.runId}`;
  const metadata = ["enable-oslogin=TRUE", "block-project-ssh-keys=TRUE", "serial-port-enable=FALSE",
    "serial-port-logging-enable=TRUE", `api-migrator-trial=${input.runId}`,
    `api-migrator-source=${input.sourceRevision}`, `api-migrator-startup-sha256=${input.startupScriptSha256}`].join(",");
  const body = {
    schemaVersion: 1, kind: "api_migrator_gcp_trial_proposal", projectId: PROJECT,
    runId: input.runId, instanceName, zone: ZONE, issuedAt: nowMs, deleteAt: input.deleteAt,
    createBefore: Math.min(nowMs + 300_000, input.deleteAt - 900_000),
    runtime: { ...RUNTIME },
    source: { repository: "Abhishekpundir23/api-migrator", revision: input.sourceRevision,
      url: `https://codeload.github.com/Abhishekpundir23/api-migrator/tar.gz/${input.sourceRevision}`,
      sha256: input.sourceArchiveSha256 },
    startup: { path: "./startup.sh", sha256: input.startupScriptSha256, contentsVerified: false },
    bootImage: { project: "debian-cloud", name: input.bootImage, existenceVerified: false },
    network: input.network, subnetwork: input.subnetwork, egress: input.egress,
    executionBlocked: true, billingApprovalRequired: true, activationBlocked: true,
    authoritativeDrill: false, releaseEvidenceEligible: false, externalSigningEligible: false,
    requiredBeforeExecution: ["billing_and_trial_credit_approval", "personal_account_no_impersonation",
      "fresh_plan_and_unused_run_identity", "reviewed_bootstrap_matches_digest", "source_and_runtime_hashes_verified",
      "boot_image_and_guest_environment_verified", "compute_api_and_quota_verified", "effective_ingress_policy_verified",
      "declared_internet_egress_verified", "off_host_logging_retention_verified", "independent_cleanup_controller_ready"],
    requiredAfterExecution: ["instance_and_boot_disk_ids_recorded", "live_configuration_matches_proposal",
      "complete_bounded_smoke_result", "logs_downloaded_and_hashed_before_delete", "exact_owned_vm_and_disk_absent",
      "logs_retrievable_after_delete"],
    commands: {
      inspectNetwork: command("compute", "networks", "describe", input.network),
      inspectSubnetwork: command("compute", "networks", "subnets", "describe", input.subnetwork, `--region=${REGION}`),
      create: command("compute", "instances", "create", instanceName, `--zone=${ZONE}`, "--machine-type=e2-medium",
        `--image=${input.bootImage}`, "--image-project=debian-cloud", "--boot-disk-size=30GB", "--boot-disk-type=pd-standard",
        "--boot-disk-auto-delete", "--no-service-account", "--no-scopes", "--no-restart-on-failure",
        "--maintenance-policy=TERMINATE", "--instance-termination-action=DELETE",
        `--termination-time=${new Date(input.deleteAt).toISOString()}`, `--network=${input.network}`,
        `--subnet=${input.subnetwork}`, "--stack-type=IPV4_ONLY",
        ...(input.egress === "existing-nat" ? ["--no-address"] : []),
        `--labels=api-migrator-trial=${input.runId}`, `--metadata=${metadata}`, "--metadata-from-file=startup-script=./startup.sh"),
      describe: command("compute", "instances", "describe", instanceName, `--zone=${ZONE}`),
      delete: command("compute", "instances", "delete", instanceName, `--zone=${ZONE}`),
      instanceInventory: command("compute", "instances", "list", `--zones=${ZONE}`, `--filter=name=${instanceName}`),
      diskInventory: command("compute", "disks", "list", `--zones=${ZONE}`),
    },
    limitations: ["proposal_only_no_cloud_calls", "startup_script_and_controller_not_implemented",
      "timer_not_a_cost_cap_or_deletion_receipt", "name_based_commands_require_fresh_exact_id_ownership_checks",
      "network_names_do_not_prove_isolation", "logging_enablement_is_not_retained_evidence"],
  };
  return { ...body, planDigest: `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}` };
}

export function renderEvidenceRead(input) {
  input = exactFields(input, ["projectId", "instanceId", "fromMs", "toMs"]);
  project(input.projectId);
  if (!matches(/^[1-9][0-9]{0,19}$/, input.instanceId) || BigInt(input.instanceId) > 18_446_744_073_709_551_615n
    || !timestamp(input.fromMs) || !timestamp(input.toMs) || input.toMs < input.fromMs || input.toMs - input.fromMs > 7_200_000) {
    throw new TypeError("evidence instance identity or time window invalid");
  }
  const query = ['resource.type="gce_instance"', `resource.labels.project_id="${PROJECT}"`,
    `resource.labels.zone="${ZONE}"`, `resource.labels.instance_id="${input.instanceId}"`,
    `logName="projects/${PROJECT}/logs/serialconsole.googleapis.com%2Fserial_port_1_output"`,
    `timestamp>="${new Date(input.fromMs).toISOString()}"`, `timestamp<="${new Date(input.toMs).toISOString()}"`].join(" AND ");
  return { command: command("logging", "read", query, "--order=asc", "--limit=1000"),
    retentionVerified: false, truncationMustBeRejected: true, activationBlocked: true };
}
