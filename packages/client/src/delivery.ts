import { ParleApiError, parseSSEBlocks, redactString, type ParleAgentClient, type ResponsiveCursorScope, type ResponsiveDeliveryMessage, type RoomRuntime } from "./index.js";

// Shared responsive delivery controller (issue #63 S4, ADR-0059).
//
// One session-scoped wake stream fans out to per-room drains. The controller
// owns wake, routing, drain ordering, deduplication, acknowledgement,
// reconnection, poison bounds, and diagnostics. Hosts supply only a handler
// and keep their own injection concerns.

// "deferred" is for hosts whose effective handling is asynchronous to the
// drain: Pi queues a row and injects it only when the assistant is idle.
// Acknowledgement still follows effective handling; the host reports when that
// happened by calling completeDeferred.
export type DeliveryHandlerResult = "handled" | "intentionally_skipped" | "deferred";

export type DeliveryHandlerInput = {
  roomId: string;
  roomHandle?: string;
  profile?: string;
  // Server-selected cursor scope for the batch this row arrived in. Hosts need
  // it for startup policy: alias-scoped delivery is durable across sessions and
  // must be handled, while session-scoped backlog from a replaced session is
  // ordinarily skipped rather than replayed into a user's context.
  cursorScope?: ResponsiveCursorScope;
  // Server room-context preamble for the batch, when present. Hosts that
  // render peer content into prompts validate exact server wrapping with it.
  preamble?: string;
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
  // Host failure policy for wake-loop errors (rate-limit parking, terminal
  // latching, footer states). Returning "stop" settles the loop without a
  // retry; the host's later start() is the recovery path. Any other return
  // keeps the controller's own terminal and backoff handling.
  onWakeError?: (error: unknown) => "continue" | "stop" | void;
  // A valid wake response has opened and exposed a readable body. Unlike
  // start(), this fires for every internal reconnect so host connectivity
  // state follows the live stream instead of the most recent failure.
  onWakeOpen?: () => void;
};

export type DeliveryRoomStatus = {
  roomId: string;
  roomHandle?: string;
  profile?: string;
  delivered: number;
  skipped: number;
  poisoned: number;
  deferred: number;
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
// A healthy stream that closes without delivering a single event is reopened
// on a short pause. Instant reopen against a server that answers and closes
// immediately would spin the loop entirely on microtasks, starving timers.
const EMPTY_STREAM_REOPEN_MS = 250;
const MAX_REMEMBERED_KEYS = 5000;

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
  private readonly onWakeError?: (error: unknown) => "continue" | "stop" | void;
  private readonly onWakeOpen?: () => void;
  // Deduplication is keyed by (roomId, eventId) and deliberately survives
  // session replacement: a new participant restarts server-side ack state, so
  // the same row can legitimately arrive again under a new generation.
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  // Rows whose handler ran but whose acknowledgement has not yet succeeded.
  // Retrying one of these re-acknowledges only; the handler never re-runs.
  private readonly handled = new Map<string, DeliveryHandlerResult>();
  private readonly poisonedKeys = new Set<string>();
  private readonly rerunRequested = new Set<string>();
  private readonly stats = new Map<string, { delivered: number; skipped: number; poisoned: number; lastError?: string }>();
  // Rows a host accepted for later effective handling. They are never
  // re-offered to the handler and never acknowledged until the host reports
  // completion, so a crash before injection leaves the row redeliverable.
  private readonly deferred = new Map<string, { roomId: string; message: ResponsiveDeliveryMessage }>();
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
    this.onWakeError = options.onWakeError;
    this.onWakeOpen = options.onWakeOpen;
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
          deferred: [...this.deferred.values()].filter((entry) => entry.roomId === room.roomId).length,
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
    this.unsubscribeRevision?.();
    this.unsubscribeRevision = (this.client as any).onSessionRevision?.(() => {
      this.wakeAbort?.abort();
      void this.drainAll().catch(() => undefined);
    });
    await this.drainAll();
    // A settled loop must not read as running forever: a terminal wake error
    // ends watchLoop, and a host's later start() is the recovery path. The
    // identity check keeps a replacement loop from being cleared by its
    // predecessor's settlement.
    const loop = this.watchLoop();
    this.loop = loop;
    void loop
      .catch((error) => {
        if (!this.abort.signal.aborted) this.lastError = redactString(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (this.loop === loop) this.loop = undefined;
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

  // A host reports effective handling of a deferred row. Only then is the row
  // acknowledged, and a failed acknowledgement is retried without re-running
  // the host handler.
  async completeDeferred(roomId: string, message: ResponsiveDeliveryMessage, outcome: Exclude<DeliveryHandlerResult, "deferred"> = "handled"): Promise<boolean> {
    const key = deliveryKey(roomId, message);
    if (this.seen.has(key)) return true;
    const stat = this.stat(roomId);
    try {
      await this.client.ackResponsiveDelivery(message, this.abort.signal, roomId);
    } catch (error) {
      stat.lastError = redactString(error instanceof Error ? error.message : String(error));
      return false;
    }
    this.deferred.delete(key);
    this.handled.delete(key);
    this.remember(key);
    if (outcome === "intentionally_skipped") stat.skipped += 1;
    else stat.delivered += 1;
    return true;
  }

  // Test seam for drain coalescing and acknowledgement retry, which are not
  // observable through the wake stream alone.
  drainForTest(roomId: string): Promise<void> {
    const room = this.configuredRooms().find((entry) => entry.roomId === roomId);
    if (!room) return Promise.resolve();
    return this.drainRoom(room);
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
        this.lastError = undefined;
        this.onWakeOpen?.();
        // A held stream does not observe an AbortSignal on its own, so the
        // pending read is cancelled explicitly; otherwise stop() would wait
        // forever on a stream that never produces another frame.
        const cancelRead = () => void reader.cancel().catch(() => undefined);
        wakeAbort.signal.addEventListener("abort", cancelRead, { once: true });
        const decoder = new TextDecoder();
        let buffer = "";
        let sawEvent = false;
        while (!wakeAbort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSSEBlocks(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            sawEvent = true;
            if (event.event === "wake") await this.handleWake(event.data);
          }
        }
        this.lastError = undefined;
        if (!wakeAbort.signal.aborted && !sawEvent) await this.sleep(EMPTY_STREAM_REOPEN_MS, this.abort.signal);
      } catch (error: any) {
        if (this.abort.signal.aborted) break;
        // A revision-driven restart is expected, not a failure.
        if (wakeAbort.signal.aborted) continue;
        this.lastError = redactString(error instanceof Error ? error.message : String(error));
        if (this.onWakeError?.(error) === "stop") return;
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

  // Coalescing must not swallow a requested drain. Joining an in-flight drain
  // would lose the immediate post-replacement pass a session revision promises,
  // because the in-flight drain may already have read past the new rows. One
  // rerun is queued per room instead.
  private drainRoom(room: RoomRuntime): Promise<void> {
    const existing = this.drainInFlight.get(room.roomId);
    if (existing) {
      this.rerunRequested.add(room.roomId);
      return existing;
    }
    const run = (async () => {
      try {
        await this.doDrainRoom(room);
      } finally {
        this.drainInFlight.delete(room.roomId);
      }
      if (this.rerunRequested.delete(room.roomId) && !this.abort.signal.aborted) {
        const current = this.configuredRooms().find((entry) => entry.roomId === room.roomId) || room;
        await this.drainRoom(current);
      }
    })();
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
      const cursorScope: ResponsiveCursorScope | undefined = delivery?.delivery?.cursor_scope === "session" || delivery?.delivery?.cursor_scope === "alias"
        ? delivery.delivery.cursor_scope
        : undefined;
      const preamble = typeof delivery?.preamble === "string" && delivery.preamble ? delivery.preamble : undefined;
      let progressed = 0;
      for (const message of messages) {
        if (this.abort.signal.aborted) return;
        const key = deliveryKey(room.roomId, message);
        if (this.seen.has(key)) continue;
        if (await this.processRow(room, message, key, cursorScope, preamble)) progressed += 1;
      }
      // A batch where nothing could be handled or acknowledged is this drain's
      // boundary. The room is not stopped: the next wake or revision drains it
      // again, and rows whose handler already ran are only re-acknowledged.
      if (progressed === 0) return;
    }
    this.stat(room.roomId).lastError = `responsive drain exceeded ${this.maxDrainBatches} batches`;
  }

  // Handling and acknowledgement are separate facts. A handler that succeeded
  // and an ack that failed must never re-run the handler: the host has already
  // acted on the row (Pi injects it), so replaying it would duplicate a visible
  // side effect. Deduplication therefore guards the handler, not the ack.
  private async processRow(room: RoomRuntime, message: ResponsiveDeliveryMessage, key: string, cursorScope?: ResponsiveCursorScope, preamble?: string): Promise<boolean> {
    const stat = this.stat(room.roomId);
    let outcome = this.handled.get(key);
    // A row already awaiting host completion is not progress. Counting it
    // would spin the drain to its batch cap every time a room has pending
    // deferred work.
    if (outcome === "deferred") return false;
    if (outcome === undefined) {
      try {
        outcome = await this.handler({
          roomId: room.roomId,
          ...(room.roomHandle ? { roomHandle: room.roomHandle } : {}),
          ...(room.profile ? { profile: room.profile } : {}),
          ...(cursorScope ? { cursorScope } : {}),
          ...(preamble ? { preamble } : {}),
          message,
        });
        this.handled.set(key, outcome);
        this.attempts.delete(key);
        if (outcome === "deferred") {
          this.deferred.set(key, { roomId: room.roomId, message });
          return true;
        }
      } catch (error) {
        const attempts = (this.attempts.get(key) || 0) + 1;
        this.attempts.set(key, attempts);
        stat.lastError = redactString(error instanceof Error ? error.message : String(error));
        if (attempts < this.maxHandlerAttempts) return true;
        // Bounded budget exhausted. The controller classifies the row as an
        // intentional skip and acknowledges it once, because leaving a
        // permanently failing row unacknowledged wedges the whole room.
        this.attempts.delete(key);
        outcome = "intentionally_skipped";
        this.handled.set(key, outcome);
        this.poisonedKeys.add(key);
        stat.poisoned += 1;
      }
    }
    try {
      await this.client.ackResponsiveDelivery(message, this.abort.signal, room.roomId);
    } catch (error) {
      // Only the acknowledgement is retried, and only on a later drain.
      stat.lastError = redactString(error instanceof Error ? error.message : String(error));
      return false;
    }
    this.handled.delete(key);
    this.remember(key);
    if (outcome === "intentionally_skipped") stat.skipped += 1;
    else stat.delivered += 1;
    return true;
  }

  // Bounded memory for a long-lived controller: dedupe only has to outlive
  // server-side redelivery, not the whole process lifetime.
  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size <= MAX_REMEMBERED_KEYS) return;
    const overflow = this.seen.size - MAX_REMEMBERED_KEYS;
    let removed = 0;
    for (const entry of this.seen) {
      this.seen.delete(entry);
      if (++removed >= overflow) break;
    }
  }
}
