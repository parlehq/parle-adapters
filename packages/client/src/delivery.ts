import { ParleApiError, parseSSEBlocks, redactString, type ParleAgentClient, type ResponsiveDeliveryMessage, type RoomRuntime } from "./index.js";

// Shared responsive delivery controller (issue #63 S4, ADR-0059).
//
// One session-scoped wake stream fans out to per-room drains. The controller
// owns wake, routing, drain ordering, deduplication, acknowledgement,
// reconnection, poison bounds, and diagnostics. Hosts supply only a handler
// and keep their own injection concerns.

export type DeliveryHandlerResult = "handled" | "intentionally_skipped";

export type DeliveryHandlerInput = {
  roomId: string;
  roomHandle?: string;
  profile?: string;
  message: ResponsiveDeliveryMessage;
};

export type DeliveryHandler = (input: DeliveryHandlerInput) => Promise<DeliveryHandlerResult> | DeliveryHandlerResult;

export type DeliveryControllerOptions = {
  handler: DeliveryHandler;
  // Bounded redelivery before a message is treated as poison. The row is left
  // unacknowledged and eligible, but the room stops re-running a handler that
  // has already failed this many times so one bad row cannot wedge the queue.
  maxHandlerAttempts?: number;
  maxDrainBatches?: number;
  reconnectDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
};

export type DeliveryRoomStatus = {
  roomId: string;
  roomHandle?: string;
  profile?: string;
  delivered: number;
  skipped: number;
  poisoned: number;
  lastError?: string;
};

export type DeliveryControllerStatus = {
  running: boolean;
  rooms: DeliveryRoomStatus[];
  // Wake hints naming rooms this session does not configure. Recorded rather
  // than fetched: an untrusted hint must never widen the room set.
  ignoredWakeHints: number;
  lastIgnoredWakeRoomId?: string;
  lastError?: string;
};

const DEFAULT_MAX_HANDLER_ATTEMPTS = 3;
const DEFAULT_MAX_DRAIN_BATCHES = 100;
const DEFAULT_RECONNECT_MS = 5000;

function deliveryKey(roomId: string, message: ResponsiveDeliveryMessage): string {
  return `${roomId}:${message.event_id}`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

export class ResponsiveDeliveryController {
  private readonly abort = new AbortController();
  private readonly handler: DeliveryHandler;
  private readonly maxHandlerAttempts: number;
  private readonly maxDrainBatches: number;
  private readonly reconnectDelayMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Deduplication is keyed by (roomId, eventId) and deliberately survives
  // session replacement: a new participant restarts server-side ack state, so
  // the same row can legitimately arrive again under a new generation.
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly poisoned = new Set<string>();
  private readonly stats = new Map<string, { delivered: number; skipped: number; poisoned: number; lastError?: string }>();
  private readonly drainInFlight = new Map<string, Promise<void>>();
  private loop?: Promise<void>;
  private unsubscribeRevision?: () => void;
  private wakeAbort?: AbortController;
  private ignoredWakeHints = 0;
  private lastIgnoredWakeRoomId?: string;
  private lastError?: string;

  constructor(private readonly client: ParleAgentClient, options: DeliveryControllerOptions) {
    this.handler = options.handler;
    this.maxHandlerAttempts = options.maxHandlerAttempts ?? DEFAULT_MAX_HANDLER_ATTEMPTS;
    this.maxDrainBatches = options.maxDrainBatches ?? DEFAULT_MAX_DRAIN_BATCHES;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  status(): DeliveryControllerStatus {
    return {
      running: Boolean(this.loop) && !this.abort.signal.aborted,
      rooms: this.configuredRooms().map((room) => {
        const stat = this.stats.get(room.roomId) || { delivered: 0, skipped: 0, poisoned: 0 };
        return {
          roomId: room.roomId,
          ...(room.roomHandle ? { roomHandle: room.roomHandle } : {}),
          ...(room.profile ? { profile: room.profile } : {}),
          delivered: stat.delivered,
          skipped: stat.skipped,
          poisoned: stat.poisoned,
          ...(stat.lastError ? { lastError: stat.lastError } : {}),
        };
      }),
      ignoredWakeHints: this.ignoredWakeHints,
      ...(this.lastIgnoredWakeRoomId ? { lastIgnoredWakeRoomId: this.lastIgnoredWakeRoomId } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.loop) return;
    await this.client.ensureBootstrapped(this.abort.signal);
    // A committed session replacement invalidates the open stream. Restart it
    // and drain immediately: the replacement participant may already have rows.
    this.unsubscribeRevision = this.client.onSessionRevision(() => {
      this.wakeAbort?.abort();
      void this.drainAll().catch(() => undefined);
    });
    await this.drainAll();
    this.loop = this.watchLoop();
    void this.loop.catch((error) => {
      if (!this.abort.signal.aborted) this.lastError = redactString(error instanceof Error ? error.message : String(error));
    });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.wakeAbort?.abort();
    this.unsubscribeRevision?.();
    this.unsubscribeRevision = undefined;
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  private configuredRooms(): RoomRuntime[] {
    return this.client.runtime.rooms || [];
  }

  private readyRooms(): RoomRuntime[] {
    return this.configuredRooms().filter((room) => room.state === "ready");
  }

  private async watchLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const wakeAbort = new AbortController();
      this.wakeAbort = wakeAbort;
      const onAbort = () => wakeAbort.abort();
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await this.client.openWakeStream(wakeAbort.signal);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Parle wake stream has no body");
        // A held stream does not observe an AbortSignal on its own, so the
        // pending read is cancelled explicitly; otherwise stop() would wait
        // forever on a stream that never produces another frame.
        const cancelRead = () => void reader.cancel().catch(() => undefined);
        wakeAbort.signal.addEventListener("abort", cancelRead, { once: true });
        const decoder = new TextDecoder();
        let buffer = "";
        while (!wakeAbort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSSEBlocks(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            if (event.event === "wake") await this.handleWake(event.data);
          }
        }
        this.lastError = undefined;
      } catch (error: any) {
        if (this.abort.signal.aborted) break;
        // A revision-driven restart is expected, not a failure.
        if (wakeAbort.signal.aborted) continue;
        this.lastError = redactString(error instanceof Error ? error.message : String(error));
        if (error instanceof ParleApiError && ["reauthorize", "fix_client", "stop"].includes(error.action || "")) throw error;
        const retryAfter = error instanceof ParleApiError && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
        try {
          await this.sleep(Math.max(retryAfter, this.reconnectDelayMs), this.abort.signal);
        } catch {
          break;
        }
      } finally {
        this.abort.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  // A hint names the room with traffic. An unknown room is counted and ignored;
  // a hintless wake falls back to draining every ready room.
  private async handleWake(data: string): Promise<void> {
    let hinted: string | undefined;
    try {
      const parsed = data ? JSON.parse(data) : undefined;
      if (parsed && typeof parsed === "object" && typeof (parsed as any).room_id === "string") hinted = (parsed as any).room_id;
    } catch {
      // A malformed hint is diagnostic noise, never a delivery failure.
    }
    if (!hinted) return this.drainAll();
    // "Configured" is the test, not "ready": a room whose entry succeeded and
    // whose projection initialization failed is genuinely entered, so the
    // server delivers and wakes on it. Ignoring its hint would strand it.
    const room = this.configuredRooms().find((entry) => entry.roomId === hinted);
    if (!room) {
      this.ignoredWakeHints += 1;
      this.lastIgnoredWakeRoomId = hinted;
      return;
    }
    await this.drainDeliverable(room);
  }

  private async drainAll(): Promise<void> {
    // Ordering is guaranteed within a room only, so rooms drain concurrently.
    await Promise.all(this.configuredRooms().map((room) => this.drainDeliverable(room).catch(() => undefined)));
  }

  // A degraded room is recovered before it is drained. Recovery reconciles
  // room entry and re-reads the watermark; a room that cannot be recovered is
  // left degraded with its error recorded rather than silently skipped.
  private async drainDeliverable(room: RoomRuntime): Promise<void> {
    if (room.state !== "ready") {
      const recovered = await this.client.recoverRoom(room.roomId, this.abort.signal);
      if (!recovered) {
        const live = this.configuredRooms().find((entry) => entry.roomId === room.roomId);
        this.stat(room.roomId).lastError = live?.lastError || "room is degraded and could not be reinitialized";
        return;
      }
    }
    const current = this.configuredRooms().find((entry) => entry.roomId === room.roomId) || room;
    await this.drainRoom(current);
  }

  private drainRoom(room: RoomRuntime): Promise<void> {
    const existing = this.drainInFlight.get(room.roomId);
    if (existing) return existing;
    const run = this.doDrainRoom(room).finally(() => this.drainInFlight.delete(room.roomId));
    this.drainInFlight.set(room.roomId, run);
    return run;
  }

  private stat(roomId: string) {
    let entry = this.stats.get(roomId);
    if (!entry) {
      entry = { delivered: 0, skipped: 0, poisoned: 0 };
      this.stats.set(roomId, entry);
    }
    return entry;
  }

  private async doDrainRoom(room: RoomRuntime): Promise<void> {
    for (let batch = 0; batch < this.maxDrainBatches; batch += 1) {
      if (this.abort.signal.aborted) return;
      let delivery: any;
      try {
        delivery = await this.client.drainResponsiveDelivery(this.abort.signal, room.roomId);
      } catch (error) {
        this.stat(room.roomId).lastError = redactString(error instanceof Error ? error.message : String(error));
        return;
      }
      const messages: ResponsiveDeliveryMessage[] = Array.isArray(delivery?.messages) ? delivery.messages : [];
      if (messages.length === 0) return;
      let progressed = 0;
      for (const message of messages) {
        if (this.abort.signal.aborted) return;
        const key = deliveryKey(room.roomId, message);
        // A poisoned row stays unacknowledged and eligible, but this process
        // stops re-running the handler that already failed on it.
        if (this.poisoned.has(key) || this.seen.has(key)) continue;
        progressed += 1;
        const outcome = await this.deliver(room, message, key);
        if (outcome === "retry") continue;
      }
      // The server cursor only advances on ack, so a batch with nothing new is
      // the drain boundary rather than a stall.
      if (progressed === 0) return;
    }
    this.stat(room.roomId).lastError = `responsive drain exceeded ${this.maxDrainBatches} batches`;
  }

  private async deliver(room: RoomRuntime, message: ResponsiveDeliveryMessage, key: string): Promise<"acked" | "retry"> {
    const stat = this.stat(room.roomId);
    try {
      const result = await this.handler({
        roomId: room.roomId,
        ...(room.roomHandle ? { roomHandle: room.roomHandle } : {}),
        ...(room.profile ? { profile: room.profile } : {}),
        message,
      });
      // Acknowledgement follows effective handling or an intentional skip, and
      // never a handler that threw or timed out.
      await this.client.ackResponsiveDelivery(message, this.abort.signal, room.roomId);
      this.seen.add(key);
      this.attempts.delete(key);
      if (result === "intentionally_skipped") stat.skipped += 1;
      else stat.delivered += 1;
      return "acked";
    } catch (error) {
      const attempts = (this.attempts.get(key) || 0) + 1;
      this.attempts.set(key, attempts);
      stat.lastError = redactString(error instanceof Error ? error.message : String(error));
      if (attempts >= this.maxHandlerAttempts) {
        this.poisoned.add(key);
        this.attempts.delete(key);
        stat.poisoned += 1;
      }
      return "retry";
    }
  }
}
