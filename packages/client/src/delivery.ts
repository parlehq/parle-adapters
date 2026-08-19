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
  random?: () => number;
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
  // Observed delivery stages. Host diagnostics must remain best-effort and
  // must not interrupt delivery when this callback fails.
  onProgress?: (kind: DeliveryProgressKind, detail?: DeliveryProgressDetail) => void;
};

export type DeliveryProgressKind = "wake_open" | "wake_hint" | "fetch_started" | "fetch_success" | "handling_complete" | "ack_success";
export type DeliveryFetchTrigger = "startup" | "wake_open" | "wake_hint" | "fallback" | "test";
export type DeliveryProgressDetail = {
  roomId?: string;
  trigger?: DeliveryFetchTrigger;
  rowCount?: number;
  scannedMax?: number;
  firstHeldSeq?: number;
  heldCount?: number;
  eventId?: string;
  seq?: number;
};

export type DeliveryErrorDomain = "recover" | "drain" | "handler" | "ack";

export type DeliveryRoomStatus = {
  roomId: string;
  roomHandle?: string;
  profile?: string;
  delivered: number;
  skipped: number;
  poisoned: number;
  deferred: number;
  lastError?: string;
  lastErrorAt?: string;
  lastErrorDomain?: DeliveryErrorDomain;
};

export type DeliveryControllerStatus = {
  running: boolean;
  rooms: DeliveryRoomStatus[];
  // Wake hints naming rooms this session does not configure. Recorded rather
  // than fetched: an untrusted hint must never widen the room set.
  ignoredWakeHints: number;
  lastIgnoredWakeRoomId?: string;
  lastError?: string;
  lastErrorAt?: string;
};

const DEFAULT_MAX_HANDLER_ATTEMPTS = 3;
const DEFAULT_MAX_DRAIN_BATCHES = 100;
const DEFAULT_RECONNECT_MS = 5000;
// ADR-0059 safe defaults apply until the wake stream supplies operator-tuned
// timing. Wake hints are advisory, so fallback fetch is part of correctness.
const DEFAULT_FALLBACK_MS = 120_000;
const DEFAULT_FALLBACK_JITTER_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_REMEMBERED_KEYS = 5000;

type WakeTiming = {
  fallbackMs: number;
  fallbackJitterMs: number;
  reconnectJitterMs: number;
};

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
  private readonly random: () => number;
  private readonly onWakeError?: (error: unknown) => "continue" | "stop" | void;
  private readonly onWakeOpen?: () => void;
  private readonly onProgress?: (kind: DeliveryProgressKind, detail?: DeliveryProgressDetail) => void;
  private readonly now: () => Date;
  // Deduplication is keyed by (roomId, eventId) and deliberately survives
  // session replacement: a new participant restarts server-side ack state, so
  // the same row can legitimately arrive again under a new generation.
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  // Rows whose handler ran but whose acknowledgement has not yet succeeded.
  // Retrying one of these re-acknowledges only; the handler never re-runs.
  private readonly handled = new Map<string, DeliveryHandlerResult>();
  private readonly poisonedKeys = new Set<string>();
  private readonly rerunRequested = new Map<string, DeliveryFetchTrigger>();
  private readonly stats = new Map<string, { delivered: number; skipped: number; poisoned: number; lastError?: { message: string; at: string; domain: DeliveryErrorDomain } }>();
  // Rows a host accepted for later effective handling. They are never
  // re-offered to the handler and never acknowledged until the host reports
  // completion, so a crash before injection leaves the row redeliverable.
  private readonly deferred = new Map<string, { roomId: string; message: ResponsiveDeliveryMessage; completionReported?: boolean }>();
  private readonly drainInFlight = new Map<string, Promise<void>>();
  private loop?: Promise<void>;
  private unsubscribeRevision?: () => void;
  private wakeAbort?: AbortController;
  private ignoredWakeHints = 0;
  private lastIgnoredWakeRoomId?: string;
  private lastError?: { message: string; at: string };
  private wakeTiming: WakeTiming = {
    fallbackMs: DEFAULT_FALLBACK_MS,
    fallbackJitterMs: DEFAULT_FALLBACK_JITTER_MS,
    reconnectJitterMs: DEFAULT_RECONNECT_JITTER_MS,
  };

  constructor(private readonly client: ParleAgentClient, options: DeliveryControllerOptions) {
    this.handler = options.handler;
    this.maxHandlerAttempts = options.maxHandlerAttempts ?? DEFAULT_MAX_HANDLER_ATTEMPTS;
    this.maxDrainBatches = options.maxDrainBatches ?? DEFAULT_MAX_DRAIN_BATCHES;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onWakeError = options.onWakeError;
    this.onWakeOpen = options.onWakeOpen;
    this.onProgress = options.onProgress;
    this.now = options.now ?? (() => new Date());
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
          ...(stat.lastError ? { lastError: stat.lastError.message, lastErrorAt: stat.lastError.at, lastErrorDomain: stat.lastError.domain } : {}),
        };
      }),
      ignoredWakeHints: this.ignoredWakeHints,
      ...(this.lastIgnoredWakeRoomId ? { lastIgnoredWakeRoomId: this.lastIgnoredWakeRoomId } : {}),
      ...(this.lastError ? { lastError: this.lastError.message, lastErrorAt: this.lastError.at } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.loop) return;
    await this.client.ensureBootstrapped(this.abort.signal);
    // A committed session replacement invalidates the old stream. The next
    // stream opens with current membership and performs the canonical recovery
    // drain after its subscriptions exist.
    this.unsubscribeRevision?.();
    this.unsubscribeRevision = (this.client as any).onSessionRevision?.(() => {
      this.wakeAbort?.abort();
    });
    await this.drainAll("startup");
    // A settled loop must not read as running forever: a terminal wake error
    // ends watchLoop, and a host's later start() is the recovery path. The
    // identity check keeps a replacement loop from being cleared by its
    // predecessor's settlement.
    const loop = this.watchLoop();
    this.loop = loop;
    void loop
      .catch((error) => {
        if (!this.abort.signal.aborted && !this.lastError) this.lastError = this.errorState(error);
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
    const deferred = this.deferred.get(key);
    if (deferred && !deferred.completionReported) {
      deferred.completionReported = true;
      this.reportProgress("handling_complete", { roomId, eventId: message.event_id, seq: message.seq });
    }
    try {
      await this.client.ackResponsiveDelivery(message, this.abort.signal, roomId);
    } catch (error) {
      this.setRoomError(roomId, "ack", error);
      return false;
    }
    this.clearRoomError(roomId, "ack");
    this.reportProgress("ack_success", { roomId, eventId: message.event_id, seq: message.seq });
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
    return this.drainRoom(room, "test");
  }

  private configuredRooms(): RoomRuntime[] {
    return this.client.runtime.rooms || [];
  }

  private readyRooms(): RoomRuntime[] {
    return this.configuredRooms().filter((room) => room.state === "ready");
  }

  private async watchLoop(): Promise<void> {
    const fallbackAbort = new AbortController();
    const abortFallback = () => fallbackAbort.abort();
    this.abort.signal.addEventListener("abort", abortFallback, { once: true });
    const fallback = this.fallbackLoop(fallbackAbort.signal);
    try {
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
          // The live stream buffers hints while durable state is reconciled. This
          // closes both the startup drain-to-subscribe race and reconnect gaps.
          await this.drainAll("wake_open");
          if (wakeAbort.signal.aborted) continue;
          this.lastError = undefined;
          this.onWakeOpen?.();
          this.reportProgress("wake_open");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!wakeAbort.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSSEBlocks(buffer);
            buffer = parsed.rest;
            for (const event of parsed.events) {
              if (event.event === "config") this.applyWakeConfig(event.data);
              else if (event.event === "wake") await this.handleWake(event.data);
            }
          }
          if (!wakeAbort.signal.aborted) throw new Error("Parle wake stream ended unexpectedly");
        } catch (error: any) {
          if (this.abort.signal.aborted) break;
          // A revision-driven restart is expected, not a failure.
          if (wakeAbort.signal.aborted) continue;
          this.lastError = this.errorState(error);
          if (this.onWakeError?.(error) === "stop") return;
          if (error instanceof ParleApiError && ["reauthorize", "fix_client", "stop"].includes(error.action || "")) throw error;
          const retryAfter = error instanceof ParleApiError && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
          try {
            await this.sleep(this.withJitter(Math.max(retryAfter, this.reconnectDelayMs), this.wakeTiming.reconnectJitterMs), this.abort.signal);
          } catch {
            break;
          }
        } finally {
          this.abort.signal.removeEventListener("abort", onAbort);
        }
      }
    } finally {
      fallbackAbort.abort();
      await fallback;
      this.abort.signal.removeEventListener("abort", abortFallback);
    }
  }

  private async fallbackLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const timing = this.wakeTiming;
      try {
        await this.sleep(this.withJitter(timing.fallbackMs, timing.fallbackJitterMs), signal);
      } catch {
        return;
      }
      if (signal.aborted) return;
      await this.drainAll("fallback");
    }
  }

  private applyWakeConfig(data: string): void {
    let config: any;
    try {
      config = JSON.parse(data);
    } catch {
      return;
    }
    if (!config || typeof config !== "object") return;
    const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_TIMER_MS;
    const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIMER_MS;
    this.wakeTiming = {
      fallbackMs: positive(config.fallback_ms) ? config.fallback_ms : this.wakeTiming.fallbackMs,
      fallbackJitterMs: nonNegative(config.fallback_jitter_ms) ? config.fallback_jitter_ms : this.wakeTiming.fallbackJitterMs,
      reconnectJitterMs: nonNegative(config.reconnect_jitter_ms) ? config.reconnect_jitter_ms : this.wakeTiming.reconnectJitterMs,
    };
  }

  private withJitter(baseMs: number, jitterMs: number): number {
    const random = this.random();
    const sample = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1 - Number.EPSILON) : 0;
    return Math.min(baseMs + Math.floor(sample * (Math.max(jitterMs, 0) + 1)), MAX_TIMER_MS);
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
    if (!hinted) return this.drainAll("wake_open");
    // "Configured" is the test, not "ready": a room whose entry succeeded and
    // whose projection initialization failed is genuinely entered, so the
    // server delivers and wakes on it. Ignoring its hint would strand it.
    const room = this.configuredRooms().find((entry) => entry.roomId === hinted);
    if (!room) {
      this.ignoredWakeHints += 1;
      this.lastIgnoredWakeRoomId = hinted;
      return;
    }
    this.reportProgress("wake_hint", { roomId: hinted });
    await this.drainDeliverable(room, "wake_hint");
  }

  private async drainAll(trigger: DeliveryFetchTrigger): Promise<void> {
    // Ordering is guaranteed within a room only, so rooms drain concurrently.
    await Promise.all(this.configuredRooms().map((room) => this.drainDeliverable(room, trigger).catch(() => undefined)));
  }

  // A degraded room is recovered before it is drained. Recovery reconciles
  // room entry and re-reads the watermark; a room that cannot be recovered is
  // left degraded with its error recorded rather than silently skipped.
  private async drainDeliverable(room: RoomRuntime, trigger: DeliveryFetchTrigger): Promise<void> {
    if (room.state !== "ready") {
      const recovered = await this.client.recoverRoom(room.roomId, this.abort.signal);
      if (!recovered) {
        const live = this.configuredRooms().find((entry) => entry.roomId === room.roomId);
        this.setRoomError(room.roomId, "recover", live?.lastError || "room is degraded and could not be reinitialized");
        return;
      }
    }
    this.clearRoomError(room.roomId, "recover");
    const current = this.configuredRooms().find((entry) => entry.roomId === room.roomId) || room;
    await this.drainRoom(current, trigger);
  }

  // Coalescing must not swallow a requested drain. Joining an in-flight drain
  // would lose a wake, reconnect, revision, or fallback pass because the
  // in-flight drain may already have read past the new rows. One rerun is queued
  // per room instead.
  private drainRoom(room: RoomRuntime, trigger: DeliveryFetchTrigger): Promise<void> {
    const existing = this.drainInFlight.get(room.roomId);
    if (existing) {
      this.rerunRequested.set(room.roomId, trigger);
      return existing;
    }
    const run = (async () => {
      try {
        await this.doDrainRoom(room, trigger);
      } finally {
        this.drainInFlight.delete(room.roomId);
      }
      const rerunTrigger = this.rerunRequested.get(room.roomId);
      this.rerunRequested.delete(room.roomId);
      if (rerunTrigger && !this.abort.signal.aborted) {
        const current = this.configuredRooms().find((entry) => entry.roomId === room.roomId) || room;
        await this.drainRoom(current, rerunTrigger);
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

  private errorState(error: unknown): { message: string; at: string } {
    return { message: redactString(error instanceof Error ? error.message : String(error)), at: this.now().toISOString() };
  }

  private setRoomError(roomId: string, domain: DeliveryErrorDomain, error: unknown): void {
    this.stat(roomId).lastError = { ...this.errorState(error), domain };
  }

  private clearRoomError(roomId: string, domain: DeliveryErrorDomain): void {
    const stat = this.stat(roomId);
    if (stat.lastError?.domain === domain) stat.lastError = undefined;
  }

  private reportProgress(kind: DeliveryProgressKind, detail?: DeliveryProgressDetail): void {
    try { this.onProgress?.(kind, detail); } catch { /* diagnostics never interrupt delivery */ }
  }

  private async doDrainRoom(room: RoomRuntime, trigger: DeliveryFetchTrigger): Promise<void> {
    for (let batch = 0; batch < this.maxDrainBatches; batch += 1) {
      if (this.abort.signal.aborted) return;
      let delivery: any;
      try {
        this.reportProgress("fetch_started", { roomId: room.roomId, trigger });
        delivery = await this.client.drainResponsiveDelivery(this.abort.signal, room.roomId);
        this.clearRoomError(room.roomId, "drain");
        const held = delivery?.held_backlog;
        this.reportProgress("fetch_success", {
          roomId: room.roomId,
          trigger,
          rowCount: Array.isArray(delivery?.messages) ? delivery.messages.length : 0,
          scannedMax: Number.isSafeInteger(delivery?.scanned_max) ? delivery.scanned_max : 0,
          firstHeldSeq: Number.isSafeInteger(held?.first_held_seq) ? held.first_held_seq : 0,
          heldCount: Number.isSafeInteger(held?.held_count) ? held.held_count : 0,
        });
      } catch (error) {
        this.setRoomError(room.roomId, "drain", error);
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
    this.setRoomError(room.roomId, "drain", `responsive drain exceeded ${this.maxDrainBatches} batches`);
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
        this.clearRoomError(room.roomId, "handler");
        this.handled.set(key, outcome);
        this.attempts.delete(key);
        if (outcome === "deferred") {
          this.deferred.set(key, { roomId: room.roomId, message });
          return true;
        }
        this.reportProgress("handling_complete", { roomId: room.roomId, eventId: message.event_id, seq: message.seq });
      } catch (error) {
        const attempts = (this.attempts.get(key) || 0) + 1;
        this.attempts.set(key, attempts);
        this.setRoomError(room.roomId, "handler", error);
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
      this.setRoomError(room.roomId, "ack", error);
      return false;
    }
    this.clearRoomError(room.roomId, "ack");
    this.reportProgress("ack_success", { roomId: room.roomId, eventId: message.event_id, seq: message.seq });
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
