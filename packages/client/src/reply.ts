export type OpaqueReplyRoute = {
  replyRouteId: string;
  interactionId: string;
  replyHop: number;
  remainingReplyHops: number;
  expiresAt: string;
};

export type ResponsiveReplyPresentation = {
  routeState: "available" | "unavailable" | "malformed";
  replyRoute?: OpaqueReplyRoute;
  authorAddress?: string;
  clientWarnings?: string[];
  lines: string[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TWO_REPLIES_REMAINING_WARNING = "This interaction has two route-mediated replies remaining. Use the opaque reply route so the other participant retains the final reply opportunity; do not switch to a selector.";

export function isOpaqueReplyRouteId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function serverDisclosedAuthorAddress(message: unknown): string | undefined {
  const address = (message as any)?.author?.address;
  if (typeof address !== "string" || !address.startsWith("@") || address.length > 256 || /\s/.test(address)) return undefined;
  return address;
}

export function normalizeOpaqueReplyRoute(value: unknown): OpaqueReplyRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const route = value as Record<string, unknown>;
  const expiresAt = typeof route.expires_at === "string" ? route.expires_at : "";
  if (!isOpaqueReplyRouteId(route.reply_route_id)
    || !isOpaqueReplyRouteId(route.interaction_id)
    || !nonNegativeInteger(route.reply_hop)
    || !nonNegativeInteger(route.remaining_reply_hops)
    || route.remaining_reply_hops < 1
    || !expiresAt
    || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  return {
    replyRouteId: route.reply_route_id,
    interactionId: route.interaction_id,
    replyHop: route.reply_hop,
    remainingReplyHops: route.remaining_reply_hops,
    expiresAt,
  };
}

export function responsiveReplyPresentation(message: unknown): ResponsiveReplyPresentation {
  const rawRoute = (message as any)?.reply_route;
  const authorAddress = serverDisclosedAuthorAddress(message);
  const route = normalizeOpaqueReplyRoute(rawRoute);
  if (route) {
    const clientWarnings = route.remainingReplyHops === 2 ? [TWO_REPLIES_REMAINING_WARNING] : undefined;
    return {
      routeState: "available",
      replyRoute: route,
      ...(authorAddress ? { authorAddress } : {}),
      ...(clientWarnings ? { clientWarnings } : {}),
      lines: [
        `reply_route_id: ${route.replyRouteId}`,
        `reply_interaction_id: ${route.interactionId}`,
        `reply_hop: ${route.replyHop}`,
        `remaining_reply_hops: ${route.remainingReplyHops}`,
        `reply_route_expires_at: ${route.expiresAt}`,
        `reply_to_author: ${authorAddress || "withheld"}`,
        `reply_instruction: To reply to this delivered message, call parle_reply with replyRouteId set exactly to ${route.replyRouteId}. Prefer this opaque route even when reply_to_author is present. Do not use parle_send, broadcast, an unaddressed send, or a guessed selector as route fallback.`,
        ...(clientWarnings ? clientWarnings.map((warning) => `clientWarnings: ${warning}`) : []),
      ],
    };
  }
  if (rawRoute !== null && rawRoute !== undefined) {
    return {
      routeState: "malformed",
      ...(authorAddress ? { authorAddress } : {}),
      lines: [
        "reply_route_state: malformed",
        `reply_to_author: ${authorAddress || "withheld"}`,
        "reply_instruction: The server reply route is malformed. Fail closed and surface the error. Do not use a selector, broadcast, an unaddressed send, or guessed identity as fallback.",
      ],
    };
  }
  return {
    routeState: "unavailable",
    ...(authorAddress ? { authorAddress } : {}),
    lines: [
      "reply_route_state: unavailable",
      `reply_to_author: ${authorAddress || "withheld"}`,
      "reply_instruction: No opaque reply route is available. Do not infer exhaustion and do not automatically fall back to a selector, broadcast, or unaddressed send. A separate deliberate new interaction may use only a selector independently disclosed by the server.",
    ],
  };
}
