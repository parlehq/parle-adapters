import type { ErrorAction, ErrorScope } from "./error-envelope.js";
export const DEFAULT_VERSION = "2026-08-17";


export class ParleApiError extends Error {
  status?: number;
  code?: string;
  action?: ErrorAction;
  scope?: ErrorScope;
  retryAfterMs?: number;
  retryable: boolean;
  details?: unknown;

  constructor(message: string, options: { status?: number; code?: string; action?: ErrorAction; scope?: ErrorScope; retryAfterMs?: number; retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "ParleApiError";
    this.status = options.status;
    this.code = options.code;
    this.action = options.action;
    this.scope = options.scope;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function parleApiErrorFields(error: ParleApiError) {
  return {
    code: error.code,
    status: error.status,
    action: error.action,
    scope: error.scope,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    ...(error.details && typeof error.details === "object" ? { details: error.details } : {}),
  };
}

const PARLE_CREDENTIAL_RE = /parle_[a-z]+_[A-Za-z0-9_-]{20,}/g;

export function isParleCredential(value: string): boolean {
  PARLE_CREDENTIAL_RE.lastIndex = 0;
  return PARLE_CREDENTIAL_RE.test(value);
}

export function redactString(input: string): string {
  let out = input
    .replace(/Bearer\s+[A-Za-z0-9_./+=:-]+/g, "Bearer <redacted>")
    .replace(/(__Host-parle_session=)[^;\s]+/g, "$1<redacted>")
    .replace(/(Idempotency-Key\s*[:=]\s*)[A-Za-z0-9._:-]+/gi, "$1<redacted>")
    .replace(/(Parle-Agent-Session\s*[:=]\s*)[A-Za-z0-9._:-]+/gi, "$1<redacted>");
  PARLE_CREDENTIAL_RE.lastIndex = 0;
  return out.replace(PARLE_CREDENTIAL_RE, "<redacted-token>");
}


export const ADDRESS_HANDLE_MIN_LENGTH = 2;
export const ADDRESS_HANDLE_MAX_LENGTH = 20;
export const SESSION_ALIAS_MAX_LENGTH = 32;
export const ADDRESS_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ANONYMOUS_SESSION_HANDLE_PATTERN = /^[a-z2-7]{16}$/;
export const RESERVED_ADDRESS_HANDLES = new Set(["admin", "agent", "agents", "api", "me", "null", "parle", "room", "rooms", "root", "support", "system", "www"]);

export function isValidAddressHandle(value: string): boolean {
  return value.length >= ADDRESS_HANDLE_MIN_LENGTH
    && value.length <= ADDRESS_HANDLE_MAX_LENGTH
    && ADDRESS_HANDLE_PATTERN.test(value)
    && !RESERVED_ADDRESS_HANDLES.has(value);
}

export function isValidSessionAlias(value: string): boolean {
  return value.length >= ADDRESS_HANDLE_MIN_LENGTH
    && value.length <= SESSION_ALIAS_MAX_LENGTH
    && ADDRESS_HANDLE_PATTERN.test(value)
    && !RESERVED_ADDRESS_HANDLES.has(value)
    && !ANONYMOUS_SESSION_HANDLE_PATTERN.test(value);
}
