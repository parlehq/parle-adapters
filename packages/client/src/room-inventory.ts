import { profileCatalogExists, readProfiles } from "./profiles.js";

export type RoomInventoryReason =
  | "runtime_not_bootstrapped"
  | "profile_catalog_missing"
  | "profile_catalog_invalid"
  | "human_session_not_configured"
  | "human_session_rejected"
  | "account_request_failed"
  | "account_response_invalid";

export type RoomInventorySection<Row> =
  | { state: "complete"; rows: Row[] }
  | { state: "truncated"; rows: Row[]; limit: number }
  | { state: "unavailable"; reason: RoomInventoryReason }
  | { state: "error"; reason: RoomInventoryReason };

export type ActiveRoomInventoryRow = {
  roomId: string;
  roomHandle: string | null;
  profile: string;
  state: string;
};

export type ConfiguredRoomInventoryRow = {
  profile: string;
  roomId: string;
};

export type AccountRoomInventoryRow = {
  roomId: string;
  roomHandle: string | null;
  private: boolean;
  createdAt: string;
  relationship: string;
  owner: {
    principalId: string;
    principalHandle: string | null;
  };
};

export type MergedRoomInventoryRow = {
  roomId: string;
  sources: {
    active: boolean;
    configured: boolean;
    account: boolean;
  };
  active?: ActiveRoomInventoryRow;
  profiles: string[];
  account?: AccountRoomInventoryRow;
};

export type ParleRoomsInventory = {
  active: RoomInventorySection<ActiveRoomInventoryRow>;
  configured: RoomInventorySection<ConfiguredRoomInventoryRow>;
  account: RoomInventorySection<AccountRoomInventoryRow>;
  rooms: MergedRoomInventoryRow[];
  compactText: string;
};

export type AccountRoomPage = {
  rooms: AccountRoomInventoryRow[];
  next: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RoomInventoryResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomInventoryResponseError";
  }
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoomInventoryResponseError(`${label} must be an object.`);
  return raw as Record<string, unknown>;
}

function uuid(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw) || raw === "00000000-0000-0000-0000-000000000000") {
    throw new RoomInventoryResponseError(`${label} must be a non-zero UUID.`);
  }
  return raw.toLowerCase();
}

function nullableString(raw: unknown, label: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new RoomInventoryResponseError(`${label} must be a string or null.`);
  return raw;
}

function nonEmptyWireString(raw: unknown, label: string, max = 4096): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new RoomInventoryResponseError(`${label} must be a bounded non-empty string without control characters.`);
  }
  return raw;
}

function timestamp(raw: unknown, label: string): string {
  const value = nonEmptyWireString(raw, label, 128);
  if (Number.isNaN(Date.parse(value))) throw new RoomInventoryResponseError(`${label} must be an ISO timestamp.`);
  return value;
}

export function parseAccountRoomPage(raw: unknown): AccountRoomPage {
  const page = record(raw, "account room response");
  if (!Array.isArray(page.rooms)) throw new RoomInventoryResponseError("account room response rooms must be an array.");
  if (page.next !== null && typeof page.next !== "string") throw new RoomInventoryResponseError("account room response next must be a string or null.");
  const next = page.next === null ? null : nonEmptyWireString(page.next, "account room response next", 8192);
  const rooms = page.rooms.map((item, index) => {
    const row = record(item, `account room row ${index}`);
    const owner = record(row.owner, `account room row ${index} owner`);
    if (typeof row.private !== "boolean") throw new RoomInventoryResponseError(`account room row ${index} private must be boolean.`);
    return {
      roomId: uuid(row.room_id, `account room row ${index} room_id`),
      roomHandle: nullableString(row.room_handle, `account room row ${index} room_handle`),
      private: row.private,
      createdAt: timestamp(row.created_at, `account room row ${index} created_at`),
      relationship: nonEmptyWireString(row.relationship, `account room row ${index} relationship`, 128),
      owner: {
        principalId: uuid(owner.principal_id, `account room row ${index} owner principal_id`),
        principalHandle: nullableString(owner.principal_handle, `account room row ${index} owner principal_handle`),
      },
    } satisfies AccountRoomInventoryRow;
  });
  return { rooms, next };
}

export function readConfiguredRoomSection(catalogPath: string): RoomInventorySection<ConfiguredRoomInventoryRow> {
  try {
    if (!profileCatalogExists(catalogPath)) return { state: "unavailable", reason: "profile_catalog_missing" };
    const profiles = readProfiles(catalogPath, { modeWarning: () => undefined });
    return {
      state: "complete",
      rows: [...profiles.values()].map((profile) => ({ profile: profile.name, roomId: profile.roomId })),
    };
  } catch {
    return { state: "error", reason: "profile_catalog_invalid" };
  }
}

export function activeRoomSectionFromStatus(status: unknown): RoomInventorySection<ActiveRoomInventoryRow> {
  const view = status && typeof status === "object" ? status as Record<string, any> : {};
  const runtime = view.runtime && typeof view.runtime === "object" ? view.runtime : {};
  if (runtime.bootstrapped !== true && runtime.bootstrapState !== "ready") {
    return { state: "unavailable", reason: "runtime_not_bootstrapped" };
  }
  const source = Array.isArray(view.rooms) ? view.rooms : Array.isArray(runtime.rooms) ? runtime.rooms : [];
  const rows = source.flatMap((raw: any) => {
    if (!raw || typeof raw !== "object" || typeof raw.roomId !== "string" || !raw.roomId) return [];
    return [{
      roomId: raw.roomId,
      roomHandle: typeof raw.roomHandle === "string" ? raw.roomHandle : null,
      profile: typeof raw.profile === "string" && raw.profile ? raw.profile : "direct",
      state: typeof raw.state === "string" && raw.state ? raw.state : "ready",
    }];
  });
  return { state: "complete", rows };
}

function rowsOf<Row>(section: RoomInventorySection<Row>): Row[] {
  return section.state === "complete" || section.state === "truncated" ? section.rows : [];
}

export function composeRoomInventory(
  active: RoomInventorySection<ActiveRoomInventoryRow>,
  configured: RoomInventorySection<ConfiguredRoomInventoryRow>,
  account: RoomInventorySection<AccountRoomInventoryRow>,
): MergedRoomInventoryRow[] {
  const activeRows = rowsOf(active);
  const configuredRows = rowsOf(configured);
  const accountRows = rowsOf(account);
  const activeByRoom = new Map(activeRows.map((row) => [row.roomId, row]));
  const accountByRoom = new Map(accountRows.map((row) => [row.roomId, row]));
  const profilesByRoom = new Map<string, string[]>();
  for (const row of configuredRows) {
    const profiles = profilesByRoom.get(row.roomId) || [];
    profiles.push(row.profile);
    profilesByRoom.set(row.roomId, profiles);
  }
  for (const profiles of profilesByRoom.values()) profiles.sort((left, right) => left.localeCompare(right));

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  const append = (roomId: string) => {
    if (!seen.has(roomId)) {
      seen.add(roomId);
      orderedIds.push(roomId);
    }
  };
  for (const row of accountRows) append(row.roomId);
  for (const row of activeRows) if (!accountByRoom.has(row.roomId)) append(row.roomId);
  for (const row of [...configuredRows].sort((left, right) => left.profile.localeCompare(right.profile) || left.roomId.localeCompare(right.roomId))) {
    if (!accountByRoom.has(row.roomId) && !activeByRoom.has(row.roomId)) append(row.roomId);
  }

  return orderedIds.map((roomId) => {
    const activeRow = activeByRoom.get(roomId);
    const accountRow = accountByRoom.get(roomId);
    const profiles = profilesByRoom.get(roomId) || [];
    return {
      roomId,
      sources: { active: Boolean(activeRow), configured: profiles.length > 0, account: Boolean(accountRow) },
      ...(activeRow ? { active: activeRow } : {}),
      profiles,
      ...(accountRow ? { account: accountRow } : {}),
    };
  });
}

function cell(raw: string): string {
  return raw.replace(/\|/g, "\\|");
}

function accountRelationship(raw: string): string {
  if (raw === "owner") return "Owner";
  if (raw === "member") return "Joined";
  return raw;
}

export function formatRoomInventory(
  active: RoomInventorySection<ActiveRoomInventoryRow>,
  configured: RoomInventorySection<ConfiguredRoomInventoryRow>,
  account: RoomInventorySection<AccountRoomInventoryRow>,
): string {
  const lines: string[] = ["Account rooms"];
  const accountRows = rowsOf(account);
  if (account.state === "complete" || account.state === "truncated") {
    lines.push("| Handle | Room ID | Type | Owner | Relationship | Created |", "| --- | --- | --- | --- | --- | --- |");
    for (const row of accountRows) {
      lines.push(`| ${cell(row.roomHandle || "Not set")} | ${row.roomId} | ${row.private ? "Private" : "Shared"} | ${cell(row.owner.principalHandle ? `@${row.owner.principalHandle}` : row.owner.principalId)} | ${cell(accountRelationship(row.relationship))} | ${row.createdAt} |`);
    }
    if (accountRows.length === 0) lines.push("| _None_ | | | | | |");
    if (account.state === "truncated") lines.push(`Account inventory truncated at the enforced ${account.limit}-row limit.`);
  } else {
    lines.push(`${account.state}: ${account.reason}`);
  }

  lines.push("", "Active now");
  if (active.state === "complete" || active.state === "truncated") {
    const rows = rowsOf(active);
    if (rows.length === 0) lines.push("None.");
    else for (const row of rows) lines.push(`- ${row.roomHandle || row.roomId} (${row.profile}, ${row.state})`);
  } else lines.push(`${active.state}: ${active.reason}`);

  lines.push("", "Configured locally");
  if (configured.state === "complete" || configured.state === "truncated") {
    const rows = rowsOf(configured);
    if (rows.length === 0) lines.push("None.");
    else for (const row of rows) lines.push(`- ${row.profile}: ${row.roomId} (unverified)`);
  } else lines.push(`${configured.state}: ${configured.reason}`);
  return lines.join("\n");
}

export function roomInventoryResult(
  active: RoomInventorySection<ActiveRoomInventoryRow>,
  configured: RoomInventorySection<ConfiguredRoomInventoryRow>,
  account: RoomInventorySection<AccountRoomInventoryRow>,
): ParleRoomsInventory {
  return {
    active,
    configured,
    account,
    rooms: composeRoomInventory(active, configured, account),
    compactText: formatRoomInventory(active, configured, account),
  };
}
