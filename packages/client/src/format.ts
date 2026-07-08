export type CompactConnectionWatcher = "on" | "off" | "unknown";

export type CompactConnectionNextKey = "open-another-session" | "already-connected" | "read-inbox" | "arm-watcher";

export type CompactConnectionCardInput = {
  connectedLabel?: string;
  sessionAddress?: string | null;
  roomHandle?: string;
  roomId?: string;
  watcher?: CompactConnectionWatcher;
  unread?: number;
  next?: CompactConnectionNextKey | string;
};

export type ConnectionSummaryLike = {
  reusedExistingSession?: boolean;
  sessionAddress?: string | null;
  roomHandle?: string;
  roomId?: string;
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
      return "arm the watcher, then stand by for messages to this Session Address.";
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

function roomLabel(input: CompactConnectionCardInput): string | undefined {
  const raw = input.roomHandle || input.roomId;
  if (!raw) return undefined;
  return raw.startsWith("#") ? raw : `#${raw}`;
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
  const room = roomLabel(input);
  if (room) lines.push(line("In room", room));
  if (input.watcher && input.watcher !== "unknown") lines.push(line("Watcher", input.watcher));
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

export function compactConnectionCardFromSummary(summary: ConnectionSummaryLike, opts: Omit<CompactConnectionCardInput, "sessionAddress" | "roomHandle" | "roomId"> = {}): string {
  return formatCompactConnectionCard({
    sessionAddress: summary.sessionAddress,
    roomHandle: summary.roomHandle,
    roomId: summary.roomId,
    next: opts.next || (summary.reusedExistingSession ? "already-connected" : undefined),
    watcher: opts.watcher,
    connectedLabel: opts.connectedLabel,
  });
}

export type StatusLike = {
  config?: {
    roomHandle?: { value?: string };
    roomId?: { value?: string; configured?: boolean };
    agentToken?: { configured?: boolean };
  };
  runtime?: {
    bootstrapState?: string;
    sessionAddress?: string | null;
    roomId?: string;
    unreadCount?: number;
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
    const unread = typeof runtime.unreadCount === "number" ? runtime.unreadCount : undefined;
    return formatCompactConnectionCard({
      sessionAddress: runtime.sessionAddress,
      roomHandle: status.config?.roomHandle?.value,
      roomId: runtime.roomId || status.config?.roomId?.value,
      unread,
      next: unread && unread > 0 ? "read-inbox" : "already-connected",
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
