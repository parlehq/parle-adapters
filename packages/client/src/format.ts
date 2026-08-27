export type CompactResponsiveDelivery = "starting" | "watching" | "backoff" | "stopped" | "terminal" | "stale" | "unknown" | "conflict";

// Host idle-wake capability as the adapter reports it. The shared formatter
// renders this generic state and never asks which host it is running on.
// `queue-only`, `daemon-attached`, and `degraded` describe a host that wakes
// its own idle turn: proven with bounded latency, proven immediate, or with a
// trigger whose delivery is unproven.
export type CompactIdleWake = "unavailable" | "unarmed" | "armed" | "queue-only" | "daemon-attached" | "degraded";

// States the delivery line names explicitly; armed and unarmed keep their
// reason-driven rendering.
const HOST_IDLE_WAKE_LINE_STATES: ReadonlySet<CompactIdleWake> = new Set(["unavailable", "queue-only", "daemon-attached", "degraded"]);

export type CompactConnectionNextKey = "open-another-session" | "already-connected" | "read-inbox" | "arm-watcher" | "arm-or-verify-watcher" | "idle-wake-unavailable" | "idle-wake-queue-only" | "idle-wake-daemon-attached" | "idle-wake-degraded" | "wait-for-watcher" | "recover-watcher" | "repair-delivery-host";

export type CompactResponsiveDeliveryInput = { state: CompactResponsiveDelivery; reason?: string; idleWake?: CompactIdleWake };

export type CompactCardRoom = { roomId?: string; roomHandle?: string; unreadCount?: number };

export type CompactConnectionCardInput = {
  connectedLabel?: string;
  sessionAddress?: string | null;
  // One entry per configured room. A single-room session simply has one.
  rooms?: CompactCardRoom[];
  responsiveDelivery?: CompactResponsiveDeliveryInput | CompactResponsiveDelivery;
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
      return "arm or verify responsive delivery.";
    case "idle-wake-unavailable":
      return "Messages arriving while idle will be delivered at the next prompt. If you need to stay available now, explicitly authorize one capped attended wait.";
    case "idle-wake-queue-only":
      return "idle wake is armed through the host queue; messages arriving while idle start a turn within about 10 seconds.";
    case "idle-wake-daemon-attached":
      return "idle wake is armed through the host daemon; messages arriving while idle start a turn immediately.";
    case "idle-wake-degraded":
      return "a wake trigger may be queued but its delivery is unproven; check Parle or prompt once.";
    case "wait-for-watcher":
      return "wait for responsive delivery startup.";
    case "recover-watcher":
      return "inspect the responsive delivery error and restart the host if it does not recover.";
    case "repair-delivery-host":
      return "restart the host after correcting the local delivery socket error.";
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

function deliveryLine(input: CompactConnectionCardInput["responsiveDelivery"]): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  if (input.idleWake && HOST_IDLE_WAKE_LINE_STATES.has(input.idleWake)) return `${input.state} (idle wake ${input.idleWake})`;
  if (input.reason === "idle_wake_unarmed") return `${input.state} (idle wake unarmed)`;
  return input.state;
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
  const delivery = deliveryLine(input.responsiveDelivery);
  if (delivery) lines.push(line("Delivery", delivery));
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
    responsiveDelivery: opts.responsiveDelivery,
    connectedLabel: opts.connectedLabel,
  });
}

export type StatusLike = {
  responsiveDelivery?: {
    state?: CompactResponsiveDelivery;
    nextActionKey?: CompactConnectionNextKey;
    nextAction?: string;
    reason?: string;
    idleWake?: CompactIdleWake;
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

// An unknown watcher normally asks for arming; a host that reports its own
// idle-wake state gets that state's guidance instead.
function unknownWatcherNext(idleWake?: CompactIdleWake): CompactConnectionNextKey {
  switch (idleWake) {
    case "unavailable":
      return "idle-wake-unavailable";
    case "queue-only":
      return "idle-wake-queue-only";
    case "daemon-attached":
      return "idle-wake-daemon-attached";
    case "degraded":
      return "idle-wake-degraded";
    default:
      return "arm-or-verify-watcher";
  }
}

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
      responsiveDelivery: status.responsiveDelivery?.state ? { state: status.responsiveDelivery.state, reason: status.responsiveDelivery.reason, idleWake: status.responsiveDelivery.idleWake } : undefined,
      next: status.responsiveDelivery?.nextActionKey || (unread && unread > 0 ? "read-inbox" : status.responsiveDelivery?.state === "unknown" ? unknownWatcherNext(status.responsiveDelivery.idleWake) : "already-connected"),
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
