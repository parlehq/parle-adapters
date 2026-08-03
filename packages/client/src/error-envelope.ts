export type ErrorAction = string;
export type ErrorScope = string;

export type ParsedErrorEnvelope = {
  code?: string;
  message?: string;
  action?: ErrorAction;
  scope?: ErrorScope;
  retryable?: boolean;
  retryAfterMs?: number;
  raw: Record<string, unknown>;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseErrorEnvelope(value: unknown): ParsedErrorEnvelope {
  const outer = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const candidate = outer.error && typeof outer.error === "object"
    ? outer.error as Record<string, unknown>
    : outer;
  const delay = candidate.retry_after_ms;
  return {
    code: nonEmptyString(candidate.code),
    message: nonEmptyString(candidate.message),
    action: nonEmptyString(candidate.action),
    scope: nonEmptyString(candidate.scope),
    retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : undefined,
    retryAfterMs: typeof delay === "number" && Number.isFinite(delay) && delay >= 0
      ? Math.trunc(delay)
      : undefined,
    raw: candidate,
  };
}
