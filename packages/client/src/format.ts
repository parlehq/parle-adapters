export type CompactConnectionWatcher = "on" | "off" | "unknown";

export type CompactConnectionNextKey = "open-another-session" | "already-connected" | "read-inbox" | "arm-watcher";

export type CompactConnectionCardInput = {
  connectedLabel?: string;
  sessionAddress?: string | null;
  roomHandle?: string;
  roomId?: string;
  watcher?: CompactConnectionWatcher;
  next?: CompactConnectionNextKey | string;
};

export type ConnectionSummaryLike = {
  reusedExistingSession?: boolean;
  sessionAddress?: string | null;
  roomHandle?: string;
  roomId?: string;
};

const DEFAULT_NEXT = "open another session and send a message to this Session Address.";

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
  const lines: string[] = [input.connectedLabel || "Connected to Parle", ""];
  const parsed = parseSessionAddress(input.sessionAddress);
  if (parsed) {
    lines.push(line("You are", `@${parsed.principal}`));
    lines.push(line("Acting as", `@${parsed.principal}.${parsed.agent}`));
  }
  const room = roomLabel(input);
  if (room) lines.push(line("In room", room));
  if (input.watcher && input.watcher !== "unknown") lines.push(line("Watcher", input.watcher));
  if (input.sessionAddress) {
    lines.push("", "Session Address:", input.sessionAddress);
  }
  lines.push("", `Next: ${nextTextFor(input.next)}`);
  return lines.join("\n");
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
