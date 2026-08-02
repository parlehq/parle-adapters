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
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  ParleAgentClient,
  ParleApiError,
  parseSSEBlocks,
  type ResponsiveDeliveryMessage,
  type ResponsiveCursorScope,
  type ResponsiveDeliveryReadFence,
  type SessionCommitPlan,
} from "@parlehq/agent-client";

const MAX_PENDING = 100;
const MAX_DRAIN_BATCHES = 100;
const MAX_BASELINE_MESSAGES = 5000;
const MAX_HOOK_BATCH = 20;
const MAX_HOOK_BYTES = 512 * 1024;
const MAX_SOCKET_INPUT = 16 * 1024;
const LEASE_MS = 30_000;
const STREAM_RECONNECT_MS = 5000;
const STREAM_RECONNECT_JITTER_MS = 1000;

export type HookDeliveryBridgeStatus = {
  running: boolean;
  pending: number;
  baselineSkipped: number;
  socketPath: string;
  hostSessionBound: boolean;
  lastError?: string;
};

type PendingMessage = ResponsiveDeliveryMessage & {
  key: string;
  sessionRevision: number;
  cursorScope?: ResponsiveCursorScope;
  roomId: string;
  sessionAlias?: string;
  agentSessionId: string;
};
type Lease = { id: string; messages: PendingMessage[]; expiresAt: number };
type DeliveryReadFence = ResponsiveDeliveryReadFence;

function deliveryKey(message: Pick<ResponsiveDeliveryMessage, "seq" | "event_id">): string {
  return `${message.seq}:${message.event_id}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function hookBridgeStateDir(scope: string): string {
  const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "parle", "hook-bridge", key);
}

export function hookBridgeSocketPath(scope: string, pid = process.pid): string {
  return join(hookBridgeStateDir(scope), `${pid}.sock`);
}

export function hookBridgeRuntimeDescriptorPath(scope: string, pid = process.pid): string {
  return join(hookBridgeStateDir(scope), `${pid}.runtime.json`);
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

export class HookDeliveryBridge {
  private readonly abortController = new AbortController();
  private readonly pending: PendingMessage[] = [];
  private readonly queuedKeys = new Set<string>();
  private server?: Server;
  private lease?: Lease;
  private loop?: Promise<void>;
  private startPromise?: Promise<void>;
  private baselineSkipped = 0;
  private lastError?: string;
  private hostSessionId?: string;
  private currentWakeAbort?: AbortController;
  private unsubscribeSessionRevision?: () => void;
  private unsubscribeCommitGuard?: () => void;
  private drainInFlight?: Promise<void>;
  private readonly activeDeliveryReads = new Set<DeliveryReadFence>();

  constructor(
    private readonly client: ParleAgentClient,
    private readonly scope = process.cwd(),
    private readonly runtimeExecPath = process.execPath,
  ) {}

  status(): HookDeliveryBridgeStatus {
    return {
      running: Boolean(this.server?.listening && !this.abortController.signal.aborted),
      pending: this.pending.length,
      baselineSkipped: this.baselineSkipped,
      socketPath: hookBridgeSocketPath(this.scope),
      hostSessionBound: Boolean(this.hostSessionId),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  bindHostSession(sessionId: string): boolean {
    if (!sessionId) return false;
    if (this.hostSessionId && this.hostSessionId !== sessionId) return false;
    this.hostSessionId = sessionId;
    return true;
  }

  async start(): Promise<void> {
    if (this.loop) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startBridge();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    this.currentWakeAbort?.abort();
    this.unsubscribeSessionRevision?.();
    this.unsubscribeSessionRevision = undefined;
    this.unsubscribeCommitGuard?.();
    this.unsubscribeCommitGuard = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.removeOwnRuntimeArtifacts();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  private async startBridge(): Promise<void> {
    try {
      this.lastError = undefined;
      this.unsubscribeCommitGuard = (this.client as any).onBeforeSessionCommit?.((plan: SessionCommitPlan) => this.guardSessionCommit(plan));
      await this.client.ensureBootstrapped(this.abortController.signal);
      this.unsubscribeSessionRevision = (this.client as any).onSessionRevision?.(() => {
        this.currentWakeAbort?.abort();
        void this.drain().catch((error) => {
          if (!this.abortController.signal.aborted) this.lastError = error instanceof Error ? error.message : String(error);
        });
      });
      await this.baseline();
      await this.listen();
      this.loop = this.watchLoop();
      void this.loop.catch((error) => {
        if (!this.abortController.signal.aborted) this.lastError = error instanceof Error ? error.message : String(error);
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.server = undefined;
      this.removeOwnRuntimeArtifacts();
    }
  }

  private async baseline(): Promise<void> {
    let skipped = 0;
    for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
      const { delivery, fence: readFence, release } = await this.readResponsiveDelivery();
      try {
        const messages = Array.isArray(delivery.messages) ? delivery.messages : [];
        if (messages.length === 0) break;
        if (delivery?.delivery?.cursor_scope === "alias") {
          if (this.enqueue(messages, delivery?.delivery?.cursor_scope, readFence) === 0) break;
          continue;
        }
        for (const message of messages) {
          skipped += 1;
          if (skipped > MAX_BASELINE_MESSAGES) throw new Error(`Parle hook bridge baseline exceeds ${MAX_BASELINE_MESSAGES} messages`);
          this.assertReadFenceCurrent(readFence);
          await this.client.ackResponsiveDelivery(message, this.abortController.signal);
        }
      } finally {
        release();
      }
    }
    this.baselineSkipped = skipped;
  }

  private async listen(): Promise<void> {
    const path = hookBridgeSocketPath(this.scope);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const before = lstatSync(dir);
    if (!before.isDirectory() || before.isSymbolicLink() || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error(`Unsafe Parle hook bridge directory: ${dir}`);
    }
    chmodSync(dir, 0o700);
    const after = lstatSync(dir);
    if ((after.mode & 0o077) !== 0) throw new Error(`Parle hook bridge directory is not owner-only: ${dir}`);
    this.removeDeadRuntimeArtifacts(dir);
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

    const descriptorPath = hookBridgeRuntimeDescriptorPath(this.scope);
    const handlePath = hookBridgeRuntimeHandlePath(this.scope);
    const descriptorTemporary = `${descriptorPath}.tmp`;
    const handleTemporary = `${handlePath}.tmp`;
    rmSync(descriptorTemporary, { force: true });
    rmSync(handleTemporary, { force: true });
    try {
      writeFileSync(descriptorTemporary, `${JSON.stringify({
        execPath,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(descriptorTemporary, 0o600);
      renameSync(descriptorTemporary, descriptorPath);
      symlinkSync(execPath, handleTemporary, "file");
      renameSync(handleTemporary, handlePath);
    } catch (error) {
      rmSync(descriptorTemporary, { force: true });
      rmSync(handleTemporary, { force: true });
      rmSync(descriptorPath, { force: true });
      rmSync(handlePath, { force: true });
      throw error;
    }
  }

  private removeOwnRuntimeArtifacts(): void {
    for (const path of [
      hookBridgeSocketPath(this.scope),
      hookBridgeRuntimeDescriptorPath(this.scope),
      hookBridgeRuntimeHandlePath(this.scope),
      `${hookBridgeRuntimeDescriptorPath(this.scope)}.tmp`,
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
      void this.handleCommand(line).then(
        (response) => socket.end(`${JSON.stringify(response)}\n`),
        (error) => socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`),
      );
    });
  }

  private async handleCommand(line: string): Promise<unknown> {
    const command = JSON.parse(line);
    if (command?.action === "status") return { ok: true, ...this.status() };
    const sessionId = typeof command?.sessionId === "string" ? command.sessionId : "";
    if (!sessionId) throw new Error("Host session id is required");
    if (command?.action === "bind") {
      const bound = this.bindHostSession(sessionId);
      return { ok: bound, bound: Boolean(this.hostSessionId) };
    }
    if (this.hostSessionId !== sessionId) return { ok: false, error: "Host session is not bound to this Parle hook bridge" };
    if (command?.action === "take") return this.take();
    if (command?.action === "commit") return this.commit(String(command.leaseId || ""));
    throw new Error("unknown Parle hook bridge action");
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
      await this.client.ackResponsiveDelivery(message, this.abortController.signal);
      const head = this.pending[0];
      if (!head || head.key !== message.key) throw new Error("Parle hook bridge pending queue changed during commit");
      this.pending.shift();
      this.queuedKeys.delete(message.key);
      committed += 1;
    }
    this.lease = undefined;
    return { ok: true, committed };
  }

  private async watchLoop(): Promise<void> {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      try {
        const wakeAbort = new AbortController();
        this.currentWakeAbort = wakeAbort;
        const wakeSignal = AbortSignal.any([signal, wakeAbort.signal]);
        await this.client.withRebootstrap(async () => {
          const response = await this.client.openWakeStream(wakeSignal);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Parle wake stream response body is not readable");
          this.lastError = undefined;
          const decoder = new TextDecoder();
          let buffer = "";
          while (!wakeSignal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSSEBlocks(buffer);
            buffer = parsed.rest;
            for (const event of parsed.events) if (event.event === "wake") await this.drain();
          }
        }, wakeSignal);
        this.lastError = undefined;
        this.currentWakeAbort = undefined;
      } catch (error: any) {
        const revisionRestart = Boolean(this.currentWakeAbort?.signal.aborted && !signal.aborted);
        this.currentWakeAbort = undefined;
        if (signal.aborted) break;
        if (revisionRestart) continue;
        this.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof ParleApiError && ["reauthorize", "fix_client", "stop"].includes(error.action || "")) throw error;
        const retryAfter = error instanceof ParleApiError && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
        await delay(Math.max(retryAfter, STREAM_RECONNECT_MS + Math.floor(Math.random() * STREAM_RECONNECT_JITTER_MS)), signal);
      }
    }
  }

  private liveLease(): Lease | undefined {
    if (this.lease && this.lease.expiresAt <= Date.now()) this.lease = undefined;
    return this.lease;
  }

  private pendingWork(): PendingMessage[] {
    const lease = this.liveLease();
    return lease ? [...this.pending, ...lease.messages] : [...this.pending];
  }

  private guardSessionCommit(plan: SessionCommitPlan): void {
    const activeReads = plan.reason === "bootstrap" ? [] : [...this.activeDeliveryReads];
    const work = [...this.pendingWork(), ...activeReads];
    if (work.length === 0) return;
    if (plan.reason === "profile_switch") {
      throw new Error("Parle profile switch is deferred while hook delivery is pending, leased, or being read");
    }
    const aliasTransfers = Boolean(plan.previous.sessionAlias
      && plan.candidate.sessionAlias === plan.previous.sessionAlias
      && plan.candidate.responsiveContinuity === "alias"
      && work.every((item) => item.cursorScope === "alias" && item.sessionAlias === plan.previous.sessionAlias && item.roomId === plan.previous.roomId));
    if (!aliasTransfers) {
      throw new Error("Parle anonymous session rollover is deferred while exact-session hook delivery is pending, leased, or being read");
    }
  }

  private deliveryReadFence(): DeliveryReadFence {
    const runtime = (this.client as any).runtime || {};
    return {
      sessionRevision: Number(runtime.sessionRevision || 0),
      cursorScope: runtime.responsiveCursorScope,
      roomId: String(runtime.roomId || ""),
      sessionAlias: typeof runtime.sessionAlias === "string" ? runtime.sessionAlias : undefined,
      agentSessionId: String(runtime.agentSessionId || ""),
    };
  }

  private async readResponsiveDelivery(): Promise<{ delivery: any; fence: DeliveryReadFence; release: () => void }> {
    const fenced = (this.client as any).drainResponsiveDeliveryWithFence;
    if (typeof fenced === "function") return fenced.call(this.client, this.abortController.signal);
    const fence = this.deliveryReadFence();
    this.activeDeliveryReads.add(fence);
    const release = () => this.activeDeliveryReads.delete(fence);
    try {
      const delivery = await this.client.drainResponsiveDelivery(this.abortController.signal);
      const responseScope = delivery?.delivery?.cursor_scope;
      if (responseScope === "session" || responseScope === "alias") fence.cursorScope = responseScope;
      return { delivery, fence, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private assertReadFenceCurrent(message: DeliveryReadFence): void {
    const runtime = (this.client as any).runtime || {};
    if (message.roomId !== String(runtime.roomId || "")) throw new Error("Parle hook delivery belongs to a prior room binding");
    if (message.cursorScope === "alias") {
      if (!message.sessionAlias || message.sessionAlias !== runtime.sessionAlias) throw new Error("Parle alias hook delivery belongs to a prior alias binding");
      return;
    }
    if (message.sessionRevision !== Number(runtime.sessionRevision || 0) || message.agentSessionId !== String(runtime.agentSessionId || "")) {
      throw new Error("Parle exact-session hook delivery belongs to a prior session revision");
    }
  }

  private assertMessageCurrent(message: PendingMessage): void {
    this.assertReadFenceCurrent(message);
  }

  private enqueue(messages: ResponsiveDeliveryMessage[], cursorScope: ResponsiveCursorScope | undefined, readFence: DeliveryReadFence): number {
    let queued = 0;
    for (const message of messages) {
      const key = deliveryKey(message);
      if (this.queuedKeys.has(key)) continue;
      if (this.pending.length >= MAX_PENDING) throw new Error(`Parle hook bridge pending queue reached ${MAX_PENDING} messages`);
      this.pending.push({
        ...message,
        key,
        sessionRevision: readFence.sessionRevision,
        cursorScope,
        roomId: readFence.roomId,
        sessionAlias: readFence.sessionAlias,
        agentSessionId: readFence.agentSessionId,
      });
      this.queuedKeys.add(key);
      queued += 1;
    }
    return queued;
  }

  private async drain(): Promise<void> {
    if (this.drainInFlight) return this.drainInFlight;
    const run = this.doDrain();
    this.drainInFlight = run;
    try { await run; } finally { this.drainInFlight = undefined; }
  }

  private async doDrain(): Promise<void> {
    for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
      const { delivery, fence: readFence, release } = await this.readResponsiveDelivery();
      try {
        if (delivery.messages.length === 0) return;
        // The server cursor advances only after hook commit acks the queued rows.
        // A repeated all-known batch is therefore the drain boundary, not a stall.
        if (this.enqueue(delivery.messages, delivery?.delivery?.cursor_scope, readFence) === 0) return;
      } finally {
        release();
      }
    }
    throw new Error(`Parle hook bridge responsive drain exceeded ${MAX_DRAIN_BATCHES} batches`);
  }
}
