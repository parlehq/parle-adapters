import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ParleAgentClient,
  ParleApiError,
  parseSSEBlocks,
  type ResponsiveDeliveryMessage,
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

type PendingMessage = ResponsiveDeliveryMessage & { key: string };
type Lease = { id: string; messages: PendingMessage[]; expiresAt: number };

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

export class HookDeliveryBridge {
  private readonly abortController = new AbortController();
  private readonly pending: PendingMessage[] = [];
  private readonly queuedKeys = new Set<string>();
  private server?: Server;
  private lease?: Lease;
  private loop?: Promise<void>;
  private baselineSkipped = 0;
  private lastError?: string;
  private hostSessionId?: string;

  constructor(private readonly client: ParleAgentClient, private readonly scope = process.cwd()) {}

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
    await this.client.ensureBootstrapped(this.abortController.signal);
    await this.baseline();
    await this.listen();
    this.loop = this.watchLoop();
    void this.loop.catch((error) => {
      if (!this.abortController.signal.aborted) this.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(hookBridgeSocketPath(this.scope), { force: true });
    await this.loop?.catch(() => undefined);
  }

  private async baseline(): Promise<void> {
    let skipped = 0;
    for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
      const delivery = await this.client.drainResponsiveDelivery(this.abortController.signal);
      if (delivery.messages.length === 0) break;
      for (const message of delivery.messages) {
        skipped += 1;
        if (skipped > MAX_BASELINE_MESSAGES) throw new Error(`Parle hook bridge baseline exceeds ${MAX_BASELINE_MESSAGES} messages`);
        await this.client.ackResponsiveDelivery(message, this.abortController.signal);
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
    rmSync(path, { force: true });
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, () => {
        this.server!.removeListener("error", reject);
        chmodSync(path, 0o600);
        resolve();
      });
    });
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
    if (this.lease && this.lease.expiresAt <= Date.now()) this.lease = undefined;
    if (this.lease) return { ok: true, busy: true, messages: [] };
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
      messages: messages.map(({ key: _key, ...message }) => message),
    };
  }

  private async commit(leaseId: string): Promise<unknown> {
    const lease = this.lease;
    if (!lease || lease.id !== leaseId || lease.expiresAt <= Date.now()) throw new Error("Parle hook bridge delivery lease is missing or expired");
    let committed = 0;
    for (const message of lease.messages) {
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
        await this.client.withRebootstrap(async () => {
          const response = await this.client.openWakeStream(signal);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Parle wake stream response body is not readable");
          this.lastError = undefined;
          const decoder = new TextDecoder();
          let buffer = "";
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSSEBlocks(buffer);
            buffer = parsed.rest;
            for (const event of parsed.events) if (event.event === "wake") await this.drain();
          }
        }, signal);
        this.lastError = undefined;
      } catch (error: any) {
        if (signal.aborted) break;
        this.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof ParleApiError && ["reauthorize", "fix_client", "stop"].includes(error.action || "")) throw error;
        const retryAfter = error instanceof ParleApiError && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
        await delay(Math.max(retryAfter, STREAM_RECONNECT_MS + Math.floor(Math.random() * STREAM_RECONNECT_JITTER_MS)), signal);
      }
    }
  }

  private async drain(): Promise<void> {
    for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
      const delivery = await this.client.drainResponsiveDelivery(this.abortController.signal);
      if (delivery.messages.length === 0) return;
      let queued = 0;
      for (const message of delivery.messages) {
        const key = deliveryKey(message);
        if (this.queuedKeys.has(key)) continue;
        if (this.pending.length >= MAX_PENDING) throw new Error(`Parle hook bridge pending queue reached ${MAX_PENDING} messages`);
        this.pending.push({ ...message, key });
        this.queuedKeys.add(key);
        queued += 1;
      }
      // The server cursor advances only after hook commit acks the queued rows.
      // A repeated all-known batch is therefore the drain boundary, not a stall.
      if (queued === 0) return;
    }
    throw new Error(`Parle hook bridge responsive drain exceeded ${MAX_DRAIN_BATCHES} batches`);
  }
}
