import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { HostIdleWake, HostIdleWakeStatus } from "./hook-delivery-bridge.js";

// The one frame the wake ever sends. It is a content-free hint: the trusted
// hook still takes, injects, and acknowledges the work on the next turn.
export const CLAUDE_MONITOR_WAKE_FRAME = "parle: responsive delivery queued";

const LOOPBACK = "127.0.0.1";
// Peer frames are ignored, so anything larger than a control frame is abuse.
const MAX_PEER_PAYLOAD_BYTES = 1024;

export type ClaudeMonitorWakeDeps = {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  log?: (event: Record<string, unknown>) => void;
};

type ClaudeMonitorWakeDetail = {
  outstanding: boolean;
  frames: number;
  attachments: number;
  lastFrameAt?: string;
  lastError?: string;
};
export type ClaudeMonitorWakeStatus = HostIdleWakeStatus & ClaudeMonitorWakeDetail;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A loopback WebSocket the Claude host's Monitor tool attaches to. The path
// token is the credential: it reaches the host only inside the owner-only
// hook `take` response, so a peer that presents it is the hook-bound session.
// One peer at a time, newest wins. The bridge keeps every decision about
// work: this module never sees content and a frame acknowledges nothing.
export class ClaudeMonitorWake implements HostIdleWake {
  readonly threadTarget = "bound" as const;
  private readonly token = randomBytes(32).toString("base64url");
  private server?: Server;
  private sockets?: WebSocketServer;
  private listening?: Promise<void>;
  private port?: number;
  private peer?: WebSocket;
  private listener?: (attached: boolean) => void;
  // True while the current peer holds a frame no hook take has consumed. A
  // frame sent to a peer that is gone is not outstanding: hints are cheap and
  // the replacement peer must hear about work that is still pending.
  private outstanding = false;
  private frames = 0;
  private attachments = 0;
  private lastFrameAt?: string;
  private lastError?: string;
  private stopped = false;

  constructor(private readonly deps: ClaudeMonitorWakeDeps = {}) {}

  start(): void {
    if (this.stopped || this.listening) return;
    this.listening = this.listen().catch((error) => {
      this.lastError = errorMessage(error);
      this.server = undefined;
      this.sockets = undefined;
      this.log({ stage: "monitor_listen_failed", error: this.lastError });
    });
  }

  stop(): void {
    this.stopped = true;
    const peer = this.peer;
    this.peer = undefined;
    this.outstanding = false;
    peer?.close(1001, "stopped");
    this.sockets?.close();
    this.server?.close();
    this.server = undefined;
    this.sockets = undefined;
    this.port = undefined;
  }

  // Resolves once the socket is bound or the bound elapses, so a status call
  // issued right after start cannot observe a half-started server.
  ready(timeoutMs: number): Promise<void> {
    if (this.stopped || !this.listening || this.port !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        resolve();
      };
      const timer = this.setTimer(finish, timeoutMs);
      this.listening!.then(finish, finish);
    });
  }

  onAttachment(listener: (attached: boolean) => void): void {
    this.listener = listener;
  }

  // The owner-only address the hook hands to the host. Never logged and never
  // part of status().
  wakeUrl(): string | undefined {
    return this.port === undefined || this.stopped ? undefined : `ws://${LOOPBACK}:${this.port}/${this.token}`;
  }

  status(): ClaudeMonitorWakeStatus {
    const base: ClaudeMonitorWakeDetail = {
      outstanding: this.outstanding,
      frames: this.frames,
      attachments: this.attachments,
      ...(this.lastFrameAt ? { lastFrameAt: this.lastFrameAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
    if (this.stopped) return { state: "unavailable", reason: "stopped", ...base };
    if (this.port === undefined) return { state: "unavailable", reason: this.listening ? (this.lastError ? "listen-failed" : "listen-pending") : "not-started", ...base };
    if (!this.peer) return { state: "unavailable", reason: "monitor-not-attached", ...base };
    return { state: "daemon-attached", ...base };
  }

  requestWake(_threadId: string, stillPending: () => boolean): void {
    if (this.stopped || !this.peer || this.peer.readyState !== WebSocket.OPEN || this.outstanding || !stillPending()) return;
    this.outstanding = true;
    this.frames += 1;
    this.lastFrameAt = new Date(this.now()).toISOString();
    this.peer.send(CLAUDE_MONITOR_WAKE_FRAME, (error) => {
      if (!error) return;
      this.lastError = errorMessage(error);
      this.outstanding = false;
      this.log({ stage: "frame_failed", error: this.lastError });
    });
    this.log({ stage: "frame_sent" });
  }

  consumeWake(): void {
    this.outstanding = false;
  }

  private async listen(): Promise<void> {
    const server = createServer((_request, response) => {
      response.writeHead(426, { Connection: "close", Upgrade: "websocket", "Content-Length": "0" });
      response.end();
    });
    const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PEER_PAYLOAD_BYTES });
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.server = server;
    this.sockets = sockets;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (this.stopped) {
      server.close();
      return;
    }
    this.port = (server.address() as AddressInfo).port;
    this.log({ stage: "monitor_listening" });
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refused = this.refuseUpgrade(request);
    if (refused) {
      socket.on("error", () => {});
      socket.end(`HTTP/1.1 ${refused}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    this.sockets!.handleUpgrade(request, socket, head, (peer) => this.attach(peer));
  }

  // The path token is the credential; Host is defense in depth against a
  // browser or proxy reaching loopback under another name. Origin is not
  // checked: the Claude host sends none.
  private refuseUpgrade(request: IncomingMessage): string | undefined {
    if (this.stopped || this.port === undefined) return "503 Service Unavailable";
    if (request.method !== "GET") return "405 Method Not Allowed";
    if (request.headers.host !== `${LOOPBACK}:${this.port}`) return "400 Bad Request";
    const expected = Buffer.from(`/${this.token}`);
    const presented = Buffer.from(request.url ?? "");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return "404 Not Found";
    return undefined;
  }

  private attach(peer: WebSocket): void {
    if (this.stopped) {
      peer.close(1001, "stopped");
      return;
    }
    const previous = this.peer;
    this.peer = peer;
    this.outstanding = false;
    this.attachments += 1;
    // The replaced peer's close is ours, so its close handler (which sees
    // this.peer !== previous) never reports a detach.
    previous?.close(1000, "replaced");
    peer.on("error", (error) => {
      this.lastError = errorMessage(error);
    });
    peer.on("close", (code) => {
      if (this.peer !== peer) return;
      this.peer = undefined;
      this.outstanding = false;
      this.log({ stage: "monitor_detached", code });
      if (!this.stopped) this.listener?.(false);
    });
    this.log({ stage: "monitor_attached", replaced: Boolean(previous) });
    this.listener?.(true);
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(callback, delayMs);
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  }

  private clearTimer(timer: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(event: Record<string, unknown>): void {
    const entry = { event: "parle_idle_wake", at: new Date(this.now()).toISOString(), ...event };
    if (this.deps.log) this.deps.log(entry);
    else console.error(JSON.stringify(entry));
  }
}
