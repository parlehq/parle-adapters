import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
} from "@parlehq/agent-client";

const MAX_PENDING = 100;
const MAX_HOOK_BATCH = 20;
const MAX_HOOK_BYTES = 512 * 1024;
const MAX_SOCKET_INPUT = 16 * 1024;
const LEASE_MS = 30_000;

export type HookDeliveryBridgeStatus = {
  running: boolean;
  pending: number;
  baselineSkipped: number;
  socketPath: string;
  hostSessionBound: boolean;
  agentSessionId?: string;
  ownerPid: number;
  hostParentPid?: number;
  currentParentPid?: number;
  lastError?: string;
  // Wake hints naming a room this process does not configure. Recorded so an
  // ignored hint is diagnosable instead of looking like lost delivery.
  ignoredWakeHints?: number;
  lastIgnoredWakeRoomId?: string;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    return true;
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
  private hostSessionId?: string;
  private waiter?: Socket;
  private unsubscribeCommitGuard?: () => void;
  private evidence?: ResponsiveDeliveryRecorder;

  constructor(
    private readonly client: ParleAgentClient,
    private readonly scope = process.cwd(),
    private readonly runtimeExecPath = process.execPath,
    private readonly evidenceCwd = process.cwd(),
    private readonly hostParentPid?: number,
    private readonly readParentPid = () => process.ppid,
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
      onProgress: () => this.publishEvidence("watching", { expectedProgressMs: 570_000, lastSuccessAt: new Date().toISOString() }),
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
    const roomError = controller.rooms.find((room) => room.lastError)?.lastError;
    const lastError = this.lastError ?? controller.lastError ?? roomError;
    return {
      running: Boolean(this.server?.listening) && !this.stopped,
      pending: this.pending.length,
      baselineSkipped: this.baselineSkipped,
      socketPath: hookBridgeSocketPath(this.scope, process.pid, this.hostParentPid),
      hostSessionBound: Boolean(this.hostSessionId),
      ownerPid: process.pid,
      ...(this.hostParentPid === undefined ? {} : { hostParentPid: this.hostParentPid, currentParentPid: this.readParentPid() }),
      ...((this.client as any).runtime?.agentSessionId ? { agentSessionId: String((this.client as any).runtime.agentSessionId) } : {}),
      ...(controller.ignoredWakeHints ? { ignoredWakeHints: controller.ignoredWakeHints, lastIgnoredWakeRoomId: controller.lastIgnoredWakeRoomId } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  bindHostSession(sessionId: string, allowReplace = false, correlated = false): boolean {
    this.assertCurrentHostParent();
    if (!sessionId || (this.hostParentPid !== undefined && !correlated)) return false;
    if (this.hostSessionId === sessionId) return true;
    if (this.liveLease() || (this.hostSessionId && !allowReplace)) return false;
    this.hostSessionId = sessionId;
    return true;
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
    this.lastError = undefined;
    this.publishEvidence("starting", { expectedProgressMs: 120_000 });
    if (!this.unsubscribeCommitGuard) {
      this.unsubscribeCommitGuard = (this.client as any).onBeforeSessionCommit?.((plan: SessionCommitPlan) => this.guardSessionCommit(plan));
    }
    if (!this.server?.listening) {
      try {
        await this.listen();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.server = undefined;
        this.removeOwnRuntimeArtifacts();
        return;
      }
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
        this.publishEvidence("watching", { expectedProgressMs: 570_000, lastSuccessAt: new Date().toISOString() });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
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
      this.lastError = this.lastError || `responsive-delivery evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
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
      sessionRevision: Number(runtime.sessionRevision || 0),
      cursorScope: input.cursorScope,
      roomId: input.roomId,
      sessionAlias: typeof runtime.sessionAlias === "string" ? runtime.sessionAlias : undefined,
      agentSessionId: String(runtime.agentSessionId || ""),
    });
    this.queuedKeys.add(key);
    this.finishWaiter({ ok: true, ready: true });
  }

  private async listen(): Promise<void> {
    this.assertCurrentHostParent();
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
    if (this.hostParentPid === undefined) this.removeDeadRuntimeArtifacts(stateDir);
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

  private removeDeadRuntimeArtifacts(dir: string): void {
    const stalePattern = /^(\d+)\.(?:sock|node|runtime\.json)(?:\.tmp)?$/;
    for (const name of readdirSync(dir)) {
      const match = name.match(stalePattern);
      if (!match || processIsAlive(Number(match[1]))) continue;
      rmSync(join(dir, name), { force: true });
    }
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
      return { ok: bound, bound: Boolean(this.hostSessionId) };
    }
    if (this.hostSessionId !== sessionId) return { ok: false, error: "Host session is not bound to this Parle hook bridge" };
    if (command?.action === "take") return this.take();
    if (command?.action === "commit") return this.commit(String(command.leaseId || ""));
    throw new Error("unknown Parle hook bridge action");
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
      socket.end(`${JSON.stringify({ ok: false, error: "Parle hook bridge already has a waiter" })}\n`);
      return;
    }
    this.waiter = socket;
    socket.once("close", () => {
      if (this.waiter === socket) this.waiter = undefined;
    });
  }

  private finishWaiter(response: unknown): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter && !waiter.destroyed) waiter.end(`${JSON.stringify(response)}\n`);
  }

  private take(): unknown {
    if (this.liveLease()) return { ok: true, busy: true, messages: [] };
    const messages: PendingMessage[] = [];
    for (const message of this.pending.slice(0, MAX_HOOK_BATCH)) {
      const candidate = [...messages, message];
      if (messages.length > 0 && Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_HOOK_BYTES) break;
      messages.push(message);
    }
    if (messages.length === 0) return { ok: true, messages: [] };
    this.lease = { id: randomUUID(), messages, expiresAt: Date.now() + LEASE_MS };
    return {
      ok: true,
      leaseId: this.lease.id,
      messages: messages.map(({ key: _key, sessionRevision: _revision, cursorScope: _scope, roomId: _room, sessionAlias: _alias, agentSessionId: _session, ...message }) => message),
    };
  }

  private async commit(leaseId: string): Promise<unknown> {
    const lease = this.lease;
    if (!lease || lease.id !== leaseId || lease.expiresAt <= Date.now()) throw new Error("Parle hook bridge delivery lease is missing or expired");
    let committed = 0;
    for (const message of lease.messages) {
      // This synchronous fence runs immediately before each credentialed ack.
      // It makes stale exact-session work impossible to acknowledge with a
      // successor credential even if a future lifecycle path bypasses guards.
      this.assertMessageCurrent(message);
      const acked = await this.controller.completeDeferred(message.roomId, message);
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
    this.lease = undefined;
    return { ok: true, committed };
  }

  private liveLease(): Lease | undefined {
    if (this.lease && this.lease.expiresAt <= Date.now()) this.lease = undefined;
    return this.lease;
  }

  private pendingWork(): PendingMessage[] {
    const lease = this.liveLease();
    return lease ? [...this.pending, ...lease.messages] : [...this.pending];
  }

  // In-flight responsive reads are fenced by the client itself, which tracks
  // every read it performs for the controller. The bridge guards only what the
  // client cannot see: rows queued or leased for the host's hook flow.
  private guardSessionCommit(plan: SessionCommitPlan): void {
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
