import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidSessionAlias } from "./protocol.js";
import { atomicReplaceOwnerOnlyFile, ensureOwnerOnlyDirectory, readOwnerOnlyTextFile, withOwnerOnlyFileLock } from "./safe-file.js";

// Nonsecret diagnostics and authorization fences only. Restart never resumes a
// session or claim from this file. Credential custody requires a separate decision.
export const ALIAS_LIFECYCLE_STATE_MAX_BYTES = 16384;
export type AliasLifecycleState = {
  version: 3;
  alias: string;
  aliasIdentityId: string;
  state: "requested" | "held" | "lost" | "refused" | "outcome_unknown";
  requestedGeneration: number;
  heldGeneration: number | null;
  lostGeneration: number | null;
  // Correlates one explicit assume invocation; not proof of human intent.
  instructionRef: string;
  operationId: string;
  observedAt: string;
};
type Store = { version: 3; current: string; records: Record<string, AliasLifecycleState> };
export type AliasLifecycleStateRead = { available: boolean; state?: AliasLifecycleState; reason?: "missing" | "malformed" };
const LABEL = "Parle alias lifecycle state";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = "alias,aliasIdentityId,heldGeneration,instructionRef,lostGeneration,observedAt,operationId,requestedGeneration,state,version";
const generation = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function aliasLifecycleStatePath(catalogPath: string, apiBase: string, roomIds: readonly string[], tokenIdentities: readonly string[]): string {
  const origin = new URL(apiBase).origin;
  const binding = createHash("sha256").update(JSON.stringify([origin, [...roomIds].sort(), [...tokenIdentities].sort()])).digest("hex");
  return join(dirname(catalogPath), `alias-lifecycle-${binding}`);
}

function readStore(path: string): Store | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readOwnerOnlyTextFile(path, { label: LABEL, maxBytes: ALIAS_LIFECYCLE_STATE_MAX_BYTES }));
  if (!value || Object.keys(value).sort().join(",") !== "current,records,version" || value.version !== 3
    || !UUID.test(value.current) || !value.records || Array.isArray(value.records)) throw new Error("invalid state");
  for (const [id, entry] of Object.entries(value.records)) {
    const e = entry as AliasLifecycleState;
    if (!e || Object.keys(e).sort().join(",") !== KEYS || !UUID.test(id) || e.aliasIdentityId !== id || e.version !== 3
      || !isValidSessionAlias(e.alias) || !["requested", "held", "lost", "refused", "outcome_unknown"].includes(e.state)
      || !generation(e.requestedGeneration) || !(e.heldGeneration === null || generation(e.heldGeneration))
      || !(e.lostGeneration === null || generation(e.lostGeneration)) || !UUID.test(e.instructionRef) || !UUID.test(e.operationId)
      || typeof e.observedAt !== "string" || !Number.isFinite(Date.parse(e.observedAt))) throw new Error("invalid state");
  }
  if (!Object.hasOwn(value.records, value.current)) throw new Error("invalid state");
  return value;
}

export function readAliasLifecycleState(path: string): AliasLifecycleStateRead {
  try {
    const store = readStore(path);
    return store ? { available: true, state: store.records[store.current] } : { available: true, reason: "missing" };
  } catch { return { available: false, reason: "malformed" }; }
}

function update(path: string, next: AliasLifecycleState, prior?: AliasLifecycleState): AliasLifecycleState | undefined {
  try {
    ensureOwnerOnlyDirectory(dirname(path), { label: `${LABEL} directory` });
    return withOwnerOnlyFileLock(path, { label: LABEL, durability: "required" }, () => {
      const store = readStore(path) || { version: 3 as const, current: next.aliasIdentityId, records: {} };
      const current = store.records[next.aliasIdentityId];
      if (prior && (!current || current.operationId !== prior.operationId || current.instructionRef !== prior.instructionRef
        || current.state !== prior.state || current.observedAt !== prior.observedAt)) return undefined;
      // Reusing an invocation reference cannot renew it. The explicit assume
      // entrypoint owns authorization; this reference supplies correlation only.
      if (!prior && current?.instructionRef === next.instructionRef) return undefined;
      store.records[next.aliasIdentityId] = next;
      if (!prior) store.current = next.aliasIdentityId;
      // Diagnostics are bounded, not an authority ledger: an evicted record
      // grants nothing and any old completion fails its compare-and-set.
      const history = Object.keys(store.records).filter((id) => id !== store.current && id !== next.aliasIdentityId
        && !["requested", "outcome_unknown"].includes(store.records[id].state));
      while (Object.keys(store.records).length > 16) {
        const settled = history.shift();
        if (!settled) return undefined; // Unresolved diagnostics require explicit resolution, never silent eviction.
        delete store.records[settled];
      }
      atomicReplaceOwnerOnlyFile(path, `${JSON.stringify(store)}\n`, {
        label: LABEL, maxBytes: ALIAS_LIFECYCLE_STATE_MAX_BYTES, durability: "required",
      });
      return next;
    });
  } catch { return undefined; }
}

/** Called only by a fresh explicit assume instruction, never startup or recovery. */
export function recordAliasAssumption(path: string, alias: string, aliasIdentityId: string, requestedGeneration: number, instructionRef: string, observedAt: string): AliasLifecycleState | undefined {
  if (!isValidSessionAlias(alias) || !UUID.test(aliasIdentityId) || !generation(requestedGeneration) || !UUID.test(instructionRef)
    || !Number.isFinite(Date.parse(observedAt))) return undefined;
  return update(path, { version: 3, alias, aliasIdentityId, requestedGeneration, instructionRef, operationId: instructionRef,
    heldGeneration: null, lostGeneration: null, observedAt, state: "requested" });
}

/** Compare the original operation, so an old response cannot clear newer intent. */
export function transitionAliasState(path: string, prior: AliasLifecycleState, state: AliasLifecycleState["state"], observedAt: string, heldGeneration = prior.heldGeneration, operationId = prior.operationId): AliasLifecycleState | undefined {
  const next = { ...prior, state, observedAt, heldGeneration, operationId,
    lostGeneration: state === "lost" ? prior.heldGeneration ?? prior.requestedGeneration : prior.lostGeneration };
  return update(path, next, prior);
}
