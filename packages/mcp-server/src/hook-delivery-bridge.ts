import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  type Stats,
  symlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  ResponsiveDeliveryController,
  atomicReplaceOwnerOnlyFile,
  type DeliveryHandlerInput,
  type DeliveryHandlerResult,
  type ParleAgentClient,
  type ResponsiveCursorScope,
  responsiveReplyPresentation,
  type ResponsiveDeliveryMessage,
  type ResponsiveReplyPresentation,
  type SessionCommitPlan,
  ResponsiveDeliveryRecorder,
  processStartedAtIso,
  readOwnerOnlyTextFile,
} from "@parlehq/agent-client";

const MAX_PENDING = 100;
const MAX_HOOK_BATCH = 20;
const MAX_HOOK_BYTES = 512 * 1024;
const MAX_SOCKET_INPUT = 16 * 1024;
const LEASE_MS = 30_000;
// Idle-wake suspension (parlehq/parle-adapters#185): the host keeps ending the
// waiter task without the bridge delivering anything (on Claude Code usually
// the memory-pressure reaper, but the bridge sees only the detach). Repeated
// detaches inside one window mean re-arming is churn, so the bridge latches a
// suspension until a human prompt arrives. The one announcement per episode is
// claimed and then committed only after the hook wrote its output, so a hook
// that dies in between does not consume it.
const WAITER_DETACH_RING = 16;
const WAITER_DETACH_WINDOW_MS = 60 * 60_000;
const WAITER_DETACH_SUSPEND_THRESHOLD = 3;
const SUSPENSION_CLAIM_MS = 10_000;

export type HookDeliveryBridgeStatus = {
  running: boolean;
  pending: number;
  baselineSkipped: number;
  socketPath: string;
  hostSessionBound: boolean;
  waiterAttached: boolean;
  // Waiter sockets that closed without a queued-delivery response in the last
  // hour, and the latched suspension they can trigger.
  waiterDetachesRecent: number;
  idleWakeSuspended: boolean;
  idleWakeSuspensionAnnounced: boolean;
  agentSessionId?: string;
  ownerPid: number;
  hostParentPid?: number;
  currentParentPid?: number;
  lastError?: string;
  lastErrorAt?: string;
  lastErrorSource?: "bridge" | "controller" | "room";
  lastErrorKind?: "listen" | "startup" | "controller" | "evidence";
  // Wake hints naming a room this process does not configure. Recorded so an
  // ignored hint is diagnosable instead of looking like lost delivery.
  ignoredWakeHints?: number;
  lastIgnoredWakeRoomId?: string;
  hostSessionId?: string;
  // The host session the MCP request metadata named. In direct-parent mode it
  // never binds; it must agree with the hook-bound session before idle wake arms.
  metaHostSessionId?: string;
  idleWake?: HostIdleWakeStatus;
};

// Host-owned idle wake. The bridge tells it when pending work appears for an
// armed host thread and when a hook take proves a live turn; the host module
// owns how a turn is started and what it can prove about that.
export type HostIdleWakeStatus = {
  state: "queue-only" | "daemon-attached" | "unavailable" | "degraded";
  reason?: string;
  [key: string]: unknown;
};

export type HostIdleWake = {
  start?(): void;
  ready?(timeoutMs: number): Promise<void>;
  requestWake(threadId: string, stillPending: () => boolean): void;
  consumeWake(): void;
  status(): HostIdleWakeStatus;
  stop?(): void;
};

type PendingMessage = ResponsiveDeliveryMessage & {
  clientReplyPresentation: ResponsiveReplyPresentation;
  key: string;
  sessionRevision: number;
  cursorScope?: ResponsiveCursorScope;
  roomId: string;
  sessionAlias?: string;
  agentSessionId: string;
};
type Lease = { id: string; messages: PendingMessage[]; expiresAt: number };
type SuspensionClaim = { id: string; expiresAt: number };

export type HookDeliveryBridgeDeps = {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

// Keyed by room first: the shared delivery contract scopes a row to its room,
// and seq/event identifiers must never collapse work across two rooms.
function deliveryKey(roomId: string, message: Pick<ResponsiveDeliveryMessage, "seq" | "event_id">): string {
  return `${roomId}:${message.seq}:${message.event_id}`;
}

export function hookBridgeStateDir(scope: string): string {
  const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "parle", "hook-bridge", key);
}

export function hookBridgeHostDir(scope: string, hostParentPid = process.ppid): string {
  if (!Number.isSafeInteger(hostParentPid) || hostParentPid <= 1) throw new Error("Parle hook bridge host parent pid must be greater than 1");
  return join(hookBridgeStateDir(scope), String(hostParentPid));
}

export function hookBridgeSocketPath(scope: string, pid = process.pid, hostParentPid?: number): string {
  return join(hostParentPid === undefined ? hookBridgeStateDir(scope) : hookBridgeHostDir(scope, hostParentPid), `${pid}.sock`);
}

export function hookBridgeRuntimeDescriptorPath(scope: string, pid = process.pid, hostParentPid?: number): string {
  return join(hostParentPid === undefined ? hookBridgeStateDir(scope) : hookBridgeHostDir(scope, hostParentPid), `${pid}.runtime.json`);
}

export function hookBridgeRuntimeHandlePath(scope: string, pid = process.pid): string {
  return join(hookBridgeStateDir(scope), `${pid}.node`);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

const CLEANUP_INSPECTION_LIMIT = 64;
const cleanupCursors = new Map<string, number>();

type HookBridgeArtifactDeps = {
  lstat?: typeof lstatSync;
  remove?: typeof unlinkSync;
  processIsAlive?: (pid: number) => boolean;
};

type HookBridgeCleanupDeps = HookBridgeArtifactDeps & {
  readdir?: typeof readdirSync;
  rmdir?: typeof rmdirSync;
};

function cleanupCandidates(dir: string, names: string[], limit: number): string[] {
  if (!names.length || limit <= 0) return [];
  names.sort();
  const start = (cleanupCursors.get(dir) ?? 0) % names.length;
  const count = Math.min(limit, names.length);
  const selected = Array.from({ length: count }, (_, offset) => names[(start + offset) % names.length]);
  cleanupCursors.set(dir, (start + count) % names.length);
  return selected;
}

function artifactPid(name: string, nested: boolean): number | undefined {
  const ordinary = name.match(nested
    ? /^(\d+)\.(?:sock|runtime\.json)(?:\.tmp)?$/
    : /^(\d+)\.(?:sock|node|runtime\.json)(?:\.tmp(?:-[0-9a-f-]{36})?)?$/i);
  if (ordinary) return Number(ordinary[1]);
  const atomic = name.match(/^\.(\d+)\.runtime\.json\.(\d+)\.[0-9a-f-]{36}\.tmp$/i);
  return atomic && atomic[1] === atomic[2] ? Number(atomic[1]) : undefined;
}

function safeArtifact(stat: Stats, name: string): boolean {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
  if (name.includes(".node")) return stat.isSymbolicLink();
  return (stat.isFile() || stat.isSocket()) && (process.platform === "win32" || (stat.mode & 0o077) === 0);
}

function validRuntimeDescriptor(path: string, name: string, pid: number, hostParentPid?: number): boolean {
  if (!name.endsWith(".runtime.json")) return true;
  try {
    const value = JSON.parse(readOwnerOnlyTextFile(path, { label: "Parle hook bridge runtime descriptor", maxBytes: 16 * 1024 }));
    return value?.pid === pid && (hostParentPid === undefined ? value.hostParentPid === undefined : value.hostParentPid === hostParentPid);
  } catch {
    return false;
  }
}

export function removeDeadHookBridgeArtifact(path: string, name: string, nested = false, hostParentPid?: number, deps: HookBridgeArtifactDeps = {}): boolean {
  const pid = artifactPid(name, nested);
  if (!Number.isSafeInteger(pid) || pid! <= 1 || pid === process.pid) return false;
  const inspect = deps.lstat || lstatSync;
  const alive = deps.processIsAlive || processIsAlive;
  try {
    const before = inspect(path);
    if (!safeArtifact(before, name) || !validRuntimeDescriptor(path, name, pid!, hostParentPid) || alive(pid!)) return false;
    const after = inspect(path);
    if (before.dev !== after.dev || before.ino !== after.ino || alive(pid!)) return false;
    (deps.remove || unlinkSync)(path);
    return true;
  } catch {
    return false;
  }
}

function safeDirectory(stat: Stats): boolean {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && (typeof process.getuid !== "function" || stat.uid === process.getuid())
    && (process.platform === "win32" || (stat.mode & 0o077) === 0);
}

/** Best-effort, bounded cleanup for artifacts owned by definitively dead processes in one scope. */
export function cleanupHookBridgeArtifacts(stateDir: string, deps: HookBridgeCleanupDeps = {}): void {
  const read = deps.readdir || readdirSync;
  const inspect = deps.lstat || lstatSync;
  const removeDir = deps.rmdir || rmdirSync;
  const alive = deps.processIsAlive || processIsAlive;
  let inspected = 0;
  let stateStat: Stats;
  let names: string[];
  try {
    stateStat = inspect(stateDir);
    if (!safeDirectory(stateStat)) return;
    names = read(stateDir);
  } catch {
    return;
  }

  const removeArtifact = (dir: string, name: string, nested: boolean, hostParentPid?: number) => {
    if (inspected >= CLEANUP_INSPECTION_LIMIT) return;
    if (artifactPid(name, nested) === undefined) return;
    inspected += 1;
    removeDeadHookBridgeArtifact(join(dir, name), name, nested, hostParentPid, deps);
  };

  for (const name of cleanupCandidates(stateDir, names, CLEANUP_INSPECTION_LIMIT)) {
    if (inspected >= CLEANUP_INSPECTION_LIMIT) break;
    const hostPid = /^\d+$/.test(name) ? Number(name) : undefined;
    if (!hostPid) {
      removeArtifact(stateDir, name, false);
      continue;
    }
    inspected += 1;
    const hostDir = join(stateDir, name);
    try {
      if (!safeDirectory(inspect(hostDir))) continue;
      const children = read(hostDir);
      for (const child of cleanupCandidates(hostDir, children, CLEANUP_INSPECTION_LIMIT - inspected)) {
        removeArtifact(hostDir, child, true, hostPid);
      }
      if (!alive(hostPid)) {
        try { removeDir(hostDir); } catch { /* Non-empty or raced directories remain. */ }
      }
    } catch { /* One raced or unsafe host directory must not block startup. */ }
  }
}

// The bridge is a queue between the shared delivery controller and the host's
// hook flow. The controller owns wake, routing, per-room drain, deduplication,
// and acknowledgement; the bridge owns only host policy: the socket protocol,
// the lease, and the fences that keep stale work from being acknowledged
// through a successor session.
export class HookDeliveryBridge {
  private readonly controller: ResponsiveDeliveryController;
  private readonly pending: PendingMessage[] = [];
  private readonly queuedKeys = new Set<string>();
  private server?: Server;
  private lease?: Lease;
  private startPromise?: Promise<void>;
  private stopped = false;
  private baselineActive = false;
  private baselineDone = false;
  private baselineSkipped = 0;
  private lastError?: string;
  private lastErrorKind?: HookDeliveryBridgeStatus["lastErrorKind"];
  private hostSessionId?: string;
  private metaHostSessionId?: string;
  private idleWakeStarted = false;
  private leaseTimer?: unknown;
  private waiter?: Socket;
  private readonly waiterDetaches: number[] = [];
  private idleWakeSuspended = false;
  private idleWakeSuspensionAnnounced = false;
  private suspensionClaim?: SuspensionClaim;
  private unsubscribeCommitGuard?: () => void;
  private evidence?: ResponsiveDeliveryRecorder;

  constructor(
    private readonly client: ParleAgentClient,
    private readonly scope = process.cwd(),
    private readonly runtimeExecPath = process.execPath,
    private readonly evidenceCwd = process.cwd(),
    private readonly hostParentPid?: number,
    private readonly readParentPid = () => process.ppid,
    private readonly idleWake?: HostIdleWake,
    private readonly deps: HookDeliveryBridgeDeps = {},
  ) {
    if (this.hostParentPid !== undefined && (!Number.isSafeInteger(this.hostParentPid) || this.hostParentPid <= 1)) {
      throw new Error("Parle hook bridge host parent pid must be greater than 1");
    }
    // The handler only ever throws on queue overflow, which is host capacity,
    // never a poison row. An unbounded attempt budget keeps the controller
    // from ever classifying an undelivered row as poison and acknowledging it.
    this.controller = new ResponsiveDeliveryController(client, {
      handler: (input) => this.handleDelivery(input),
      maxHandlerAttempts: Number.MAX_SAFE_INTEGER,
      onProgress: (kind, detail) => {
        const at = new Date().toISOString();
        console.error(JSON.stringify({ event: "parle_responsive_delivery", stage: kind, at, ...detail }));
        this.publishEvidence("watching", {
          expectedProgressMs: 570_000,
          ...(["wake_open", "fetch_success"].includes(kind) ? { lastSuccessAt: at } : {}),
          ...(kind === "wake_hint" ? { lastWakeAt: at } : {}),
          ...(kind === "ack_success" ? { lastAckAt: at } : {}),
        });
      },
      onWakeError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const action = typeof error === "object" && error !== null ? (error as { action?: string }).action : undefined;
        if (["reauthorize", "fix_client", "stop"].includes(action || "")) this.publishEvidence("terminal", { reason: action || "wake_terminal", lastError: message });
        else this.publishEvidence("backoff", { expectedProgressMs: 30_000, lastError: message });
      },
    });
  }

  status(): HookDeliveryBridgeStatus {
    const controller = this.controller.status();
    const roomStatus = controller.rooms.find((room) => room.lastError);
    const lastError = this.lastError ?? controller.lastError ?? roomStatus?.lastError;
    const lastErrorSource = this.lastError ? "bridge" : controller.lastError ? "controller" : roomStatus?.lastError ? "room" : undefined;
    const lastErrorAt = lastErrorSource === "controller" ? controller.lastErrorAt : lastErrorSource === "room" ? roomStatus?.lastErrorAt : undefined;
    return {
      running: Boolean(this.server?.listening) && !this.stopped,
      pending: this.pending.length,
      baselineSkipped: this.baselineSkipped,
      socketPath: hookBridgeSocketPath(this.scope, process.pid, this.hostParentPid),
      hostSessionBound: Boolean(this.hostSessionId),
      waiterAttached: Boolean(this.waiter),
      waiterDetachesRecent: this.recentWaiterDetaches(Date.now()),
      idleWakeSuspended: this.idleWakeSuspended,
      idleWakeSuspensionAnnounced: this.idleWakeSuspensionAnnounced,
      ownerPid: process.pid,
      ...(this.hostParentPid === undefined ? {} : { hostParentPid: this.hostParentPid, currentParentPid: this.readParentPid() }),
      ...((this.client as any).runtime?.agentSessionId ? { agentSessionId: String((this.client as any).runtime.agentSessionId) } : {}),
      ...(controller.ignoredWakeHints ? { ignoredWakeHints: controller.ignoredWakeHints, lastIgnoredWakeRoomId: controller.lastIgnoredWakeRoomId } : {}),
      ...(this.hostSessionId ? { hostSessionId: this.hostSessionId } : {}),
      ...(this.metaHostSessionId ? { metaHostSessionId: this.metaHostSessionId } : {}),
      ...(this.idleWake ? { idleWake: this.idleWakeStatus() } : {}),
      ...(lastError ? { lastError } : {}),
      ...(lastErrorAt ? { lastErrorAt } : {}),
      ...(lastErrorSource ? { lastErrorSource } : {}),
      ...(this.lastErrorKind ? { lastErrorKind: this.lastErrorKind } : {}),
    };
  }

  bindHostSession(sessionId: string, allowReplace = false, correlated = false): boolean {
    this.assertCurrentHostParent();
    if (!sessionId) return false;
    if (this.hostParentPid !== undefined && !correlated) {
      // In-band metadata never binds a correlated bridge; it is recorded as
      // the cross-check that idle wake needs before it may start a turn.
      if (this.metaHostSessionId !== sessionId) {
        this.metaHostSessionId = sessionId;
        this.requestIdleWake();
      }
      return false;
    }
    if (this.hostSessionId === sessionId) return true;
    // A live suspension claim fences replacement like a live delivery lease:
    // the claiming session must be able to commit the line it already wrote,
    // or the replacement could repeat the same episode's announcement.
    if (this.liveLease() || this.liveSuspensionClaim() || (this.hostSessionId && !allowReplace)) return false;
    // A binding that MCP metadata confirmed and that still holds work is a
    // live thread in this process; another thread's SessionStart must not
    // take that work. An unconfirmed binding (a host that passes no thread
    // metadata, or a thread that never called a tool) is replaceable so a
    // cleared session in the same process is not stranded.
    if (this.hostSessionId && this.metaHostSessionId === this.hostSessionId && this.pending.length > 0) return false;
    this.hostSessionId = sessionId;
    this.requestIdleWake();
    return true;
  }

  // Bounded wait for the host's idle-wake verification, so a status card
  // rendered right after connect reflects the settled state.
  awaitIdleWakeReady(timeoutMs: number): Promise<void> {
    return this.idleWake?.ready?.(timeoutMs) ?? Promise.resolve();
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startBridge();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearLease();
    this.idleWake?.stop?.();
    this.finishWaiter({ ok: false, error: "Parle hook bridge stopped" });
    this.publishEvidence("stopped", { reason: "host_shutdown" });
    await this.controller.stop();
    this.unsubscribeCommitGuard?.();
    this.unsubscribeCommitGuard = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.removeOwnRuntimeArtifacts();
  }

  private async startBridge(): Promise<void> {
    if (this.server?.listening && this.controller.status().running) return;
    if (!this.lastError) this.publishEvidence("starting", { expectedProgressMs: 120_000 });
    if (!this.unsubscribeCommitGuard) {
      this.unsubscribeCommitGuard = (this.client as any).onBeforeSessionCommit?.((plan: SessionCommitPlan) => this.guardSessionCommit(plan));
    }
    if (!this.server?.listening) {
      try {
        await this.listen();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.lastErrorKind = typeof error === "object" && error !== null && (error as { syscall?: string }).syscall === "listen" ? "listen" : "startup";
        this.server = undefined;
        this.removeOwnRuntimeArtifacts();
        this.publishEvidence("terminal", { reason: this.lastErrorKind === "listen" ? "bridge_listen_failed" : "bridge_start_failed", lastError: this.lastError });
        return;
      }
      this.lastError = undefined;
      this.lastErrorKind = undefined;
    }
    // Host verification is independent of the thread binding, so it starts as
    // soon as the bridge listens and is usually complete before the first
    // status call.
    if (!this.idleWakeStarted) {
      this.idleWakeStarted = true;
      this.idleWake?.start?.();
    }
    // The socket and runtime artifacts outlive a bootstrap or wake failure:
    // hooks keep a status endpoint to diagnose through, and a later start()
    // retries the controller without republishing anything. Only the first
    // successful start is the baseline window: rows found by a retry after a
    // wake failure arrived for this live session and must queue, not skip.
    if (!this.controller.status().running) {
      this.baselineActive = !this.baselineDone;
      try {
        await this.controller.start();
        this.baselineDone = true;
        this.lastError = undefined;
        this.lastErrorKind = undefined;
        this.publishEvidence("watching", { expectedProgressMs: 570_000 });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.lastErrorKind = "controller";
        this.publishEvidence("backoff", { expectedProgressMs: 30_000, lastError: this.lastError });
      } finally {
        this.baselineActive = false;
      }
    }
  }

  private publishEvidence(state: "starting" | "watching" | "backoff" | "stopped" | "terminal", event: Record<string, unknown> = {}): void {
    const runtime = (this.client as any).runtime || {};
    if (!runtime.agentSessionId) return;
    if (!this.evidence) {
      this.evidence = new ResponsiveDeliveryRecorder({
        cwd: this.evidenceCwd,
        persist: true,
        processStartedAt: processStartedAtIso(),
        publisher: {
          name: "@parlehq/mcp-server:hook-bridge",
          clientInstanceId: String((this.client as any).clientInstanceId || "hook-bridge"),
        },
        target: { agentSessionId: String(runtime.agentSessionId) },
      });
    } else if (this.evidence.snapshot()?.target.agentSessionId !== String(runtime.agentSessionId)) {
      this.evidence.retarget({ agentSessionId: String(runtime.agentSessionId) });
    }
    try {
      this.evidence.record(state, event as any);
    } catch (error) {
      if (!this.lastError) {
        this.lastError = `responsive-delivery evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
        this.lastErrorKind = "evidence";
      }
    }
  }

  // Session-scoped backlog present before the bridge's first drain belongs to
  // a replaced session and is skipped rather than replayed into the host.
  // Alias-scoped rows are durable across sessions and always queue.
  private handleDelivery(input: DeliveryHandlerInput): DeliveryHandlerResult {
    if (this.baselineActive && input.cursorScope !== "alias") {
      this.baselineSkipped += 1;
      return "intentionally_skipped";
    }
    this.enqueue(input);
    return "deferred";
  }

  private enqueue(input: DeliveryHandlerInput): void {
    const key = deliveryKey(input.roomId, input.message);
    if (this.queuedKeys.has(key)) return;
    if (this.pending.length >= MAX_PENDING) throw new Error(`Parle hook bridge pending queue reached ${MAX_PENDING} messages`);
    const runtime = (this.client as any).runtime || {};
    this.pending.push({
      ...input.message,
      clientReplyPresentation: responsiveReplyPresentation(input.message),
      key,
      sessionRevision: input.sourceFence?.sessionRevision ?? Number(runtime.sessionRevision || 0),
      cursorScope: input.cursorScope,
      roomId: input.roomId,
      sessionAlias: input.sourceFence?.sessionAlias ?? (typeof runtime.sessionAlias === "string" ? runtime.sessionAlias : undefined),
      agentSessionId: input.sourceFence?.agentSessionId ?? String(runtime.agentSessionId || ""),
    });
    this.queuedKeys.add(key);
    console.error(JSON.stringify({
      event: "parle_responsive_delivery",
      stage: "bridge_queue_ready",
      at: new Date().toISOString(),
      roomId: input.roomId,
      eventId: input.message.event_id,
      seq: input.message.seq,
    }));
    this.finishWaiter({ ok: true, ready: true });
    this.requestIdleWake();
  }

  private async listen(): Promise<void> {
    this.assertCurrentHostParent();
    cleanupHookBridgeArtifacts(hookBridgeStateDir(this.scope));
    const path = hookBridgeSocketPath(this.scope, process.pid, this.hostParentPid);
    const stateDir = hookBridgeStateDir(this.scope);
    const dir = dirname(path);
    for (const candidate of [stateDir, dir]) {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      const before = lstatSync(candidate);
      if (!before.isDirectory() || before.isSymbolicLink() || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
        throw new Error(`Unsafe Parle hook bridge directory: ${candidate}`);
      }
      chmodSync(candidate, 0o700);
      const after = lstatSync(candidate);
      if ((after.mode & 0o077) !== 0) throw new Error(`Parle hook bridge directory is not owner-only: ${candidate}`);
    }
    this.removeOwnRuntimeArtifacts();
    this.publishRuntimeArtifacts();
    try {
      this.server = createServer((socket) => this.handleSocket(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(path, () => {
          this.server!.removeListener("error", reject);
          chmodSync(path, 0o600);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      this.removeOwnRuntimeArtifacts();
      throw error;
    }
  }

  private publishRuntimeArtifacts(): void {
    const execPath = this.runtimeExecPath;
    if (!isAbsolute(execPath)) throw new Error("Parle hook bridge Node runtime path is not absolute");
    accessSync(execPath, constants.X_OK);
    if (!statSync(execPath).isFile()) throw new Error("Parle hook bridge Node runtime path is not a file");

    const descriptorPath = hookBridgeRuntimeDescriptorPath(this.scope, process.pid, this.hostParentPid);
    const handlePath = hookBridgeRuntimeHandlePath(this.scope);
    const handleTemporary = `${handlePath}.tmp-${randomUUID()}`;
    try {
      atomicReplaceOwnerOnlyFile(descriptorPath, `${JSON.stringify({
        execPath,
        pid: process.pid,
        ...(this.hostParentPid === undefined ? {} : { hostParentPid: this.hostParentPid }),
        startedAt: this.hostParentPid === undefined ? new Date().toISOString() : processStartedAtIso(),
      })}\n`, { label: "Parle hook bridge runtime descriptor", maxBytes: 16 * 1024, durability: "none" });
      symlinkSync(execPath, handleTemporary, "file");
      renameSync(handleTemporary, handlePath);
    } catch (error) {
      rmSync(handleTemporary, { force: true });
      rmSync(descriptorPath, { force: true });
      rmSync(handlePath, { force: true });
      throw error;
    }
  }

  private removeOwnRuntimeArtifacts(): void {
    for (const path of [
      hookBridgeSocketPath(this.scope, process.pid, this.hostParentPid),
      hookBridgeRuntimeDescriptorPath(this.scope, process.pid, this.hostParentPid),
      hookBridgeRuntimeHandlePath(this.scope),
      `${hookBridgeRuntimeDescriptorPath(this.scope, process.pid, this.hostParentPid)}.tmp`,
      `${hookBridgeRuntimeHandlePath(this.scope)}.tmp`,
    ]) rmSync(path, { force: true });
  }

  private assertCurrentHostParent(): void {
    if (this.hostParentPid !== undefined && this.readParentPid() !== this.hostParentPid) {
      throw new Error("Parle hook bridge host process correlation is no longer valid");
    }
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_SOCKET_INPUT) socket.destroy();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      socket.removeAllListeners("data");
      let command: any;
      try {
        command = JSON.parse(line);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        return;
      }
      if (command?.action === "wait") {
        this.wait(socket, String(command.agentSessionId || ""));
        return;
      }
      void this.handleCommand(command).then(
        (response) => socket.end(`${JSON.stringify(response)}\n`),
        (error) => socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`),
      );
    });
  }

  private async handleCommand(command: any): Promise<unknown> {
    if (command?.action === "status") return { ok: true, ...this.status() };
    this.assertCurrentHostParent();
    const sessionId = typeof command?.sessionId === "string" ? command.sessionId : "";
    if (!sessionId) throw new Error("Host session id is required");
    if (command?.action === "bind") {
      const bound = this.bindHostSession(sessionId, command?.allowReplace === true, true);
      // A human prompt ends the suspension episode: the next eligible Stop may
      // ask to re-arm again and a fresh episode owes a fresh announcement.
      if (bound && command?.hookEventName === "UserPromptSubmit") this.resetIdleWakeSuspension();
      return { ok: bound, bound: Boolean(this.hostSessionId) };
    }
    if (this.hostSessionId !== sessionId) return { ok: false, error: "Host session is not bound to this Parle hook bridge" };
    if (command?.action === "take") return this.take();
    if (command?.action === "commit") return this.commit(String(command.leaseId || ""));
    if (command?.action === "announce-suspension") return this.announceSuspension(command?.claim === true);
    if (command?.action === "commit-suspension") return this.commitSuspension(String(command.claimId || ""));
    throw new Error("unknown Parle hook bridge action");
  }

  private recentWaiterDetaches(now: number): number {
    return this.waiterDetaches.filter((at) => at > now - WAITER_DETACH_WINDOW_MS).length;
  }

  // Called when the attached waiter socket closes before the bridge ended it
  // with a queued-delivery response: the host reaped or killed the task.
  private recordWaiterDetach(at = Date.now()): void {
    this.waiterDetaches.push(at);
    if (this.waiterDetaches.length > WAITER_DETACH_RING) this.waiterDetaches.splice(0, this.waiterDetaches.length - WAITER_DETACH_RING);
    if (!this.idleWakeSuspended && this.recentWaiterDetaches(at) >= WAITER_DETACH_SUSPEND_THRESHOLD) {
      this.idleWakeSuspended = true;
      this.idleWakeSuspensionAnnounced = false;
      console.error(JSON.stringify({ event: "parle_responsive_delivery", stage: "idle_wake_suspended", at: new Date(at).toISOString(), detaches: this.waiterDetaches.length }));
    }
  }

  // The announcement is owed exactly once per suspension episode. A hook that
  // sends claim:true gets a claim that becomes final only on commit, so an
  // expired uncommitted claim is owed again. A hook that omits it (an older
  // plugin hook against this bridge during a live update) cannot commit, so
  // its announcement is marked final in this one step.
  private announceSuspension(claim: boolean): { ok: true; owed: boolean; claimId?: string } {
    const owed = this.idleWakeSuspended && !this.idleWakeSuspensionAnnounced && !this.liveSuspensionClaim();
    if (!owed) return { ok: true, owed: false };
    if (!claim) {
      this.idleWakeSuspensionAnnounced = true;
      return { ok: true, owed: true };
    }
    this.suspensionClaim = { id: randomUUID(), expiresAt: Date.now() + SUSPENSION_CLAIM_MS };
    return { ok: true, owed: true, claimId: this.suspensionClaim.id };
  }

  private commitSuspension(claimId: string): { ok: true; announced: true } {
    const claim = this.liveSuspensionClaim();
    if (!claim || claim.id !== claimId) throw new Error("Parle hook bridge suspension claim is missing or expired");
    this.suspensionClaim = undefined;
    this.idleWakeSuspensionAnnounced = true;
    return { ok: true, announced: true };
  }

  private liveSuspensionClaim(): SuspensionClaim | undefined {
    if (this.suspensionClaim && this.suspensionClaim.expiresAt <= Date.now()) this.suspensionClaim = undefined;
    return this.suspensionClaim;
  }

  private resetIdleWakeSuspension(): void {
    this.waiterDetaches.length = 0;
    this.idleWakeSuspended = false;
    this.idleWakeSuspensionAnnounced = false;
    this.suspensionClaim = undefined;
  }

  private wait(socket: Socket, agentSessionId: string): void {
    const current = String((this.client as any).runtime?.agentSessionId || "");
    if (!agentSessionId || agentSessionId !== current) {
      socket.end(`${JSON.stringify({ ok: false, error: "Parle agent session does not own this hook bridge" })}\n`);
      return;
    }
    if (this.pending.length > 0) {
      socket.end(`${JSON.stringify({ ok: true, ready: true })}\n`);
      return;
    }
    if (this.waiter) {
      socket.end(`${JSON.stringify({ ok: true, ready: true, alreadyAttached: true })}\n`);
      return;
    }
    this.waiter = socket;
    socket.once("close", () => {
      if (this.waiter !== socket) return;
      this.waiter = undefined;
      this.recordWaiterDetach();
    });
  }

  private finishWaiter(response: unknown): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter && !waiter.destroyed) waiter.end(`${JSON.stringify(response)}\n`);
  }

  // The response carries a status snapshot taken now, not at the hook's
  // earlier discovery probe, so a suspension latched in between is seen.
  private take(): unknown {
    // Any take from the bound session, busy or not, proves a live host turn,
    // which is all a queued wake trigger exists to produce. Work left behind
    // is re-armed by commit or by lease expiry.
    this.idleWake?.consumeWake();
    // The response carries a status snapshot taken now, not at the hook's
    // earlier discovery probe, so a suspension latched in between is seen.
    if (this.liveLease()) return { ok: true, busy: true, messages: [], status: this.status() };
    const messages: PendingMessage[] = [];
    for (const message of this.pending.slice(0, MAX_HOOK_BATCH)) {
      const candidate = [...messages, message];
      if (messages.length > 0 && Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_HOOK_BYTES) break;
      messages.push(message);
    }
    if (messages.length === 0) return { ok: true, messages: [], status: this.status() };
    this.lease = { id: randomUUID(), messages, expiresAt: this.now() + LEASE_MS };
    // An uncommitted lease expires actively: the rows become leasable again
    // and, if the host is idle, wake is requested for them.
    this.leaseTimer = this.setTimer(() => {
      this.leaseTimer = undefined;
      if (this.lease && this.lease.expiresAt <= this.now()) this.lease = undefined;
      this.requestIdleWake();
    }, LEASE_MS);
    return {
      ok: true,
      leaseId: this.lease.id,
      messages: messages.map(({ key: _key, sessionRevision: _revision, cursorScope: _scope, roomId: _room, sessionAlias: _alias, agentSessionId: _session, ...message }) => message),
      status: this.status(),
    };
  }

  private async commit(leaseId: string): Promise<unknown> {
    const lease = this.liveLease();
    if (!lease || lease.id !== leaseId) throw new Error("Parle hook bridge delivery lease is missing or expired");
    let committed = 0;
    for (const message of lease.messages) {
      // This synchronous fence runs immediately before each credentialed ack.
      // It makes stale exact-session work impossible to acknowledge with a
      // successor credential even if a future lifecycle path bypasses guards.
      this.assertMessageCurrent(message);
      const acked = await this.controller.completeDeferred(
        message.roomId,
        message,
        "handled",
        message.cursorScope === "alias" ? undefined : {
          sessionRevision: message.sessionRevision,
          agentSessionId: message.agentSessionId,
        },
      );
      if (!acked) {
        const roomError = this.controller.status().rooms.find((room) => room.roomId === message.roomId)?.lastError;
        throw new Error(`Parle hook bridge acknowledgement failed: ${roomError || "acknowledgement did not complete"}`);
      }
      const head = this.pending[0];
      if (!head || head.key !== message.key) throw new Error("Parle hook bridge pending queue changed during commit");
      this.pending.shift();
      this.queuedKeys.delete(message.key);
      committed += 1;
    }
    this.clearLease();
    this.requestIdleWake();
    return { ok: true, committed };
  }

  private liveLease(): Lease | undefined {
    if (this.lease && this.lease.expiresAt <= this.now()) this.clearLease();
    return this.lease;
  }

  private clearLease(): void {
    this.lease = undefined;
    if (this.leaseTimer !== undefined) {
      if (this.deps.clearTimer) this.deps.clearTimer(this.leaseTimer);
      else clearTimeout(this.leaseTimer as ReturnType<typeof setTimeout>);
      this.leaseTimer = undefined;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(callback, delayMs);
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  }

  // Idle wake may start a turn only on the thread the trusted hook bound, and
  // only once the MCP request metadata has named the same thread.
  private idleWakeThread(): { threadId?: string; reason?: string } {
    if (!this.hostSessionId) return { reason: "host-session-unbound" };
    if (!this.metaHostSessionId) return { reason: "host-session-unconfirmed" };
    if (this.metaHostSessionId !== this.hostSessionId) return { reason: "host-session-conflict" };
    return { threadId: this.hostSessionId };
  }

  private requestIdleWake(): void {
    if (!this.idleWake || this.stopped || this.pending.length === 0 || this.liveLease()) return;
    const { threadId } = this.idleWakeThread();
    if (!threadId) return;
    this.idleWake.requestWake(threadId, () => this.pending.length > 0 && !this.liveLease());
  }

  private idleWakeStatus(): HostIdleWakeStatus | undefined {
    if (!this.idleWake) return undefined;
    const wake = this.idleWake.status();
    if (wake.state !== "queue-only" && wake.state !== "daemon-attached") return wake;
    const thread = this.idleWakeThread();
    return thread.threadId ? wake : { ...wake, state: "unavailable", reason: thread.reason };
  }

  private pendingWork(): PendingMessage[] {
    const lease = this.liveLease();
    return lease ? [...this.pending, ...lease.messages] : [...this.pending];
  }

  private abandonEndedSessionWork(previous: Readonly<{ sessionRevision?: number; agentSessionId?: string }>): void {
    const dropped = new Set<string>();
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const item = this.pending[index];
      if (item.cursorScope === "alias" || item.sessionRevision !== Number(previous.sessionRevision || 0) || item.agentSessionId !== String(previous.agentSessionId || "")) continue;
      this.pending.splice(index, 1);
      this.queuedKeys.delete(item.key);
      this.controller.abandonDeferred(item.roomId, item);
      dropped.add(item.key);
    }
    if (this.lease?.messages.some((item) => dropped.has(item.key))) this.clearLease();
  }

  // In-flight responsive reads are fenced by the client itself, which tracks
  // every read it performs for the controller. The bridge guards only what the
  // client cannot see: rows queued or leased for the host's hook flow.
  private guardSessionCommit(plan: SessionCommitPlan): void {
    if (plan.reason === "rebootstrap") this.abandonEndedSessionWork(plan.previous);
    const work = this.pendingWork();
    if (work.length === 0) return;
    if (plan.reason === "profile_switch") {
      throw new Error("Parle profile switch is deferred while hook delivery is pending or leased");
    }
    const aliasTransfers = Boolean(plan.previous.sessionAlias
      && plan.candidate.sessionAlias === plan.previous.sessionAlias
      && plan.candidate.responsiveContinuity === "alias"
      && work.every((item) => item.cursorScope === "alias" && item.sessionAlias === plan.previous.sessionAlias && plan.previous.rooms.some((room) => room.roomId === item.roomId)));
    if (!aliasTransfers) {
      throw new Error("Parle anonymous session rollover is deferred while exact-session hook delivery is pending or leased");
    }
  }

  private assertMessageCurrent(message: PendingMessage): void {
    const runtime = (this.client as any).runtime || {};
    const configured = Array.isArray(runtime.rooms) && runtime.rooms.some((room: any) => room?.roomId === message.roomId);
    if (!configured) throw new Error("Parle hook delivery belongs to a prior room binding");
    if (message.cursorScope === "alias") {
      if (!message.sessionAlias || message.sessionAlias !== runtime.sessionAlias) throw new Error("Parle alias hook delivery belongs to a prior alias binding");
      return;
    }
    if (message.sessionRevision !== Number(runtime.sessionRevision || 0) || message.agentSessionId !== String(runtime.agentSessionId || "")) {
      throw new Error("Parle exact-session hook delivery belongs to a prior session revision");
    }
  }
}
