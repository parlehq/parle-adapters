export type CompactConnectionWatcher = "on" | "off" | "degraded" | "unknown";

export type CompactConnectionNextKey = "open-another-session" | "already-connected" | "read-inbox" | "arm-watcher" | "arm-or-verify-watcher" | "recover-watcher";

// Temporary L1 wording until core discovery authors watcher next-step guidance.
export const WATCHER_UNKNOWN_GUIDANCE = {
  state: "unknown" as const,
  nextActionKey: "arm-or-verify-watcher" as const,
  nextAction: "arm or verify the watcher",
};

export type CompactCardRoom = { roomId?: string; roomHandle?: string; unreadCount?: number };

export type CompactConnectionCardInput = {
  connectedLabel?: string;
  sessionAddress?: string | null;
  // One entry per configured room. A single-room session simply has one.
  rooms?: CompactCardRoom[];
  watcher?: CompactConnectionWatcher;
  unread?: number;
  next?: CompactConnectionNextKey | string;
};

export type ConnectionSummaryLike = {
  reusedExistingSession?: boolean;
  sessionAddress?: string | null;
  rooms?: CompactCardRoom[];
};

const DEFAULT_NEXT = "open another session and send a message to this Session Address.";
const CARD_RULE = "========================================";

export function nextTextFor(key?: CompactConnectionNextKey | string): string {
  if (!key) return DEFAULT_NEXT;
  switch (key) {
    case "open-another-session":
      return DEFAULT_NEXT;
    case "already-connected":
      return "read your inbox when you are ready.";
    case "read-inbox":
      return "read your inbox for messages addressed to this session.";
    case "arm-watcher":
    case "arm-or-verify-watcher":
      return `${WATCHER_UNKNOWN_GUIDANCE.nextAction}.`;
    case "recover-watcher":
      return "inspect the responsive delivery error and restart the host if it does not recover.";
    default:
      return key;
  }
}

export function parseSessionAddress(address?: string | null): { principal: string; agent: string } | undefined {
  if (!address) return undefined;
  const match = address.match(/^@([^\.\s]+)\.([^\.\s]+)\.([^\.\s]+)$/);
  if (!match) return undefined;
  return { principal: match[1], agent: match[2] };
}

function roomLabels(rooms?: CompactCardRoom[]): string[] {
  return (rooms || [])
    .map((room) => room.roomHandle || room.roomId)
    .filter((raw): raw is string => Boolean(raw))
    .map((raw) => (raw.startsWith("#") ? raw : `#${raw}`));
}

function line(label: string, value: string): string {
  return `${label.padEnd(14, " ")}${value}`;
}

export function formatCompactConnectionCard(input: CompactConnectionCardInput): string {
  const lines: string[] = [CARD_RULE, input.connectedLabel || "Connected to Parle", ""];
  const parsed = parseSessionAddress(input.sessionAddress);
  if (parsed) {
    lines.push(line("You are", `@${parsed.principal}`));
    lines.push(line("Acting as", `@${parsed.principal}.${parsed.agent}`));
  }
  const rooms = roomLabels(input.rooms);
  if (rooms.length === 1) lines.push(line("In room", rooms[0]));
  else if (rooms.length > 1) lines.push(line("In rooms", rooms.join(", ")));
  if (input.watcher) lines.push(line("Watcher", input.watcher));
  if (typeof input.unread === "number" && input.unread > 0) lines.push(line("Unread", String(input.unread)));
  if (input.sessionAddress) {
    lines.push("", "Session Address:", input.sessionAddress);
  }
  lines.push("", `Next: ${nextTextFor(input.next)}`, CARD_RULE);
  // Cards with an empty middle (not-connected variants) would otherwise render
  // consecutive blank lines.
  const collapsed = lines.filter((entry, index) => entry !== "" || lines[index - 1] !== "");
  return collapsed.join("\n");
}

export function compactConnectionCardFromSummary(summary: ConnectionSummaryLike, opts: Omit<CompactConnectionCardInput, "sessionAddress" | "rooms"> = {}): string {
  return formatCompactConnectionCard({
    sessionAddress: summary.sessionAddress,
    rooms: summary.rooms,
    next: opts.next || (summary.reusedExistingSession ? "already-connected" : undefined),
    watcher: opts.watcher,
    connectedLabel: opts.connectedLabel,
  });
}

export type StatusLike = {
  watcher?: {
    state?: CompactConnectionWatcher;
    nextActionKey?: CompactConnectionNextKey;
    nextAction?: string;
  };
  config?: {
    roomHandle?: { value?: string };
    roomId?: { value?: string; configured?: boolean };
    agentToken?: { configured?: boolean };
  };
  rooms?: CompactCardRoom[];
  runtime?: {
    bootstrapState?: string;
    sessionAddress?: string | null;
    rooms?: CompactCardRoom[];
  };
};

// The status-path counterpart of the connect card: "status" is where users ask
// for the standard card most (connect output has usually scrolled away), and a
// missing field guarantees improvised summaries. Deliberately excludes cursor,
// expiry, and UUIDs (the skill says not to surface them); provenance JSON stays
// alongside for diagnostics.
export function compactStatusCardFromStatus(status: StatusLike): string {
  const runtime = status.runtime;
  if (runtime?.bootstrapState === "ready" && runtime.sessionAddress) {
    const rooms = status.rooms?.length ? status.rooms : runtime.rooms;
    // Unread is summed across rooms: the card answers "does anything want me",
    // and per-room detail lives in the status JSON.
    const counts = (rooms || []).map((room) => room.unreadCount).filter((count): count is number => typeof count === "number");
    const unread = counts.length ? counts.reduce((total, count) => total + count, 0) : undefined;
    return formatCompactConnectionCard({
      sessionAddress: runtime.sessionAddress,
      rooms: rooms?.length ? rooms : (status.config?.roomId?.value ? [{ roomId: status.config.roomId.value, roomHandle: status.config?.roomHandle?.value }] : undefined),
      unread,
      watcher: status.watcher?.state,
      next: status.watcher?.nextActionKey || (unread && unread > 0 ? "read-inbox" : "already-connected"),
    });
  }
  const configured = Boolean(status.config?.roomId?.configured && status.config?.agentToken?.configured);
  if (configured) {
    return formatCompactConnectionCard({
      connectedLabel: "Parle configured, not connected",
      next: "run parle_connect to establish the session.",
    });
  }
  return formatCompactConnectionCard({
    connectedLabel: "Parle not configured",
    next: "run parle_setup to diagnose configuration.",
  });
}
