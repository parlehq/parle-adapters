import { randomUUID } from "node:crypto";

let processClientInstance: string | undefined;

// Ephemeral process identity for request attribution. The UUID is minted lazily
// on first use, then retained for the rest of the runtime. Laziness lets
// one-shot child helpers consume an owner-provided value without minting an
// unused per-helper identifier during module loading.
export function processClientInstanceId(): string {
  processClientInstance ||= randomUUID();
  return processClientInstance;
}

const REPORTED_METADATA_LIMIT = 96;
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]{1,32})?$/;

function assertReportedMetadataBounds(value: string, label: string): void {
  if (value.length === 0 || value.length > REPORTED_METADATA_LIMIT || !/^[\x20-\x7e]+$/.test(value)) {
    throw new Error(`Parle ${label} must be 1 to ${REPORTED_METADATA_LIMIT} printable ASCII bytes.`);
  }
}

export function assertClientName(value: string): string {
  assertReportedMetadataBounds(value, "clientName");
  if (!NPM_PACKAGE_NAME_RE.test(value)) throw new Error("Parle clientName must be an npm package name.");
  return value;
}

export function assertClientVersion(value: string): string {
  assertReportedMetadataBounds(value, "clientVersion");
  if (!SEMVER_RE.test(value)) throw new Error("Parle clientVersion must be SemVer with at most one bounded build suffix.");
  return value;
}

export function assertClientInstanceId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Parle clientInstanceId must be a canonical UUIDv4 or UUIDv7.");
  }
  return value.toLowerCase();
}
