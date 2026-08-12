#!/usr/bin/env node
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { INBOX_COMPLETENESS_GUIDANCE, INBOX_REPLY_GUIDANCE, SEND_ATTENTION_GUIDANCE, ParleAccountClient, ParleAgentClient, ParleApiError, ProfileConfigError, ProfileNotFoundError, ReadParams, SendParams, SubmitReplyParams, activeRoomSectionFromStatus, assertClientInstanceId, assertClientName, assertClientVersion, compactConnectionCardFromSummary, compactStatusCardFromStatus, inspectResponsiveDeliveryPid, processClientInstanceId, processStartedAtIso, readResponsiveDeliverySnapshots, redactResponsiveDeliveryDiagnostic, redactString, resolveConfig, resolveResponsiveDelivery, ResponsiveDeliveryRecorder, type AcceptRoomInvitationParams, type ActiveRoomInventoryRow, type AddOwnAgentSeatParams, type ClaimPrincipalInviteParams, type ClientOptions, type ConnectOwnAgentParams, type CreateRoomParams, type HardenAccountParams, type LoginParams, type MintPrincipalInviteParams, type OwnedAliasDeliveryParams, type OwnedAliasReleaseParams, type ParleRoomsInventory, type RoomInventorySection, knownAddressContextFor, parseKeyValueFile, resolveProfileCatalogPath } from "@parlehq/agent-client";
import { HookDeliveryBridge } from "./hook-delivery-bridge.js";
import { registerParleTools, type DegradedMcpBoot, type HookDeliveryBridgeLike, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";
export { hostSessionIdFromMeta, registerParleTools, type DegradedMcpBoot, type HookDeliveryBridgeLike, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";

export const MCP_CLIENT_NAME = "@parlehq/mcp-server";
export const MCP_CLIENT_VERSION = "0.7.29";
const inheritedWatcherInstance = process.argv[2] === "--parle-watch-request" ? process.env.PARLE_WATCH_CLIENT_INSTANCE_ID : undefined;
export const MCP_CLIENT_INSTANCE_ID = inheritedWatcherInstance ? assertClientInstanceId(inheritedWatcherInstance) : processClientInstanceId();

export function resolveIntegrationMetadata(env: Record<string, string | undefined> = process.env): Pick<ClientOptions, "integrationName" | "integrationVersion"> {
  const rawName = env.PARLE_INTEGRATION_NAME;
  const rawVersion = env.PARLE_INTEGRATION_VERSION;
  if (rawVersion && !rawName) throw new Error("PARLE_INTEGRATION_VERSION requires PARLE_INTEGRATION_NAME.");
  return {
    integrationName: rawName ? assertClientName(rawName) : undefined,
    integrationVersion: rawVersion ? assertClientVersion(rawVersion) : undefined,
  };
}

export function createMcpAgentClient(options: ClientOptions = {}): ParleAgentClient {
  return new ParleAgentClient({
    ...options,
    clientName: MCP_CLIENT_NAME,
    clientVersion: MCP_CLIENT_VERSION,
    clientInstanceId: MCP_CLIENT_INSTANCE_ID,
    ...resolveIntegrationMetadata(options.env),
  });
}

export function createParleMcpServer(
  client: ParleMcpClientLike = createMcpAgentClient(),
  accountClient: ParleAccountClientLike = new ParleAccountClient(),
  deliveryBridge?: HookDeliveryBridgeLike,
  degradedBoot?: DegradedMcpBoot,
  exposeDegradedTools = false,
) {
  const server = new McpServer({ name: "parle-mcp-server", version: MCP_CLIENT_VERSION });
  registerParleTools(
    ((...args: any[]) => (server.registerTool as any)(...args)) as RegisterParleTool,
    client,
    accountClient,
    deliveryBridge,
    degradedBoot,
    exposeDegradedTools,
  );
  return server;
}

export async function runStdio() {
  const responsiveDelivery = process.env.PARLE_RESPONSIVE_DELIVERY;
  if (responsiveDelivery && responsiveDelivery !== "hook-bridge") {
    throw new Error(`Unsupported PARLE_RESPONSIVE_DELIVERY mode: ${responsiveDelivery}`);
  }
  const hookBridgeEnabled = responsiveDelivery === "hook-bridge";
  const createRuntime = () => {
    const clientEnv = hookBridgeEnabled ? { ...process.env, PARLE_UNREAD_POLL_INTERVAL_SECONDS: "0" } : process.env;
    const client = createMcpAgentClient({ env: clientEnv, publishRuntime: { adapterName: MCP_CLIENT_NAME, adapterVersion: MCP_CLIENT_VERSION } });
    if (hookBridgeEnabled) {
      client.switchProfile = async () => {
        throw new Error("Live Parle profile switching is unavailable while the hook bridge owns responsive delivery. Restart the host with the target PARLE_PROFILE so the MCP session, wake stream, queue, and hook binding change atomically.");
      };
    }
    const deliveryBridge = hookBridgeEnabled
      ? new HookDeliveryBridge(client, process.env.PARLE_HOOK_BRIDGE_SCOPE || process.cwd())
      : undefined;
    if (deliveryBridge) {
      const baseStatus = client.status.bind(client);
      client.status = () => ({ ...baseStatus(), responsiveDeliveryBridge: deliveryBridge.status() });
    }
    return { client, accountClient: new ParleAccountClient(), deliveryBridge };
  };
  let activated = false;
  const activateRuntime = (runtime: ReturnType<typeof createRuntime>) => {
    if (activated) return;
    activated = true;
    // Eager background bootstrap creates the session before the first tool call.
    // A retryable startup failure arms one unreferenced deadline at a time from
    // the shared client's server-derived nextRetryAt. Terminal or unconfigured
    // states have no retry deadline and therefore schedule no automatic work.
    const stopEagerBootstrap = scheduleEagerBootstrap(runtime.client, runtime.deliveryBridge, {
      onError(error) {
        console.error(`Parle hook delivery bridge stopped: ${redactString(error instanceof Error ? error.message : String(error))}`);
      },
    });
    installLifecycleHandlers(runtime.client, runtime.deliveryBridge, stopEagerBootstrap);
  };

  let runtime: ReturnType<typeof createRuntime> | undefined;
  let configError: ProfileConfigError | undefined;
  try {
    runtime = createRuntime();
  } catch (error) {
    if (!(error instanceof ProfileConfigError)) throw error;
    configError = error;
    console.error(`Parle degraded boot: ${redactString(error.message)}`);
  }

  const server = runtime
    ? createParleMcpServer(runtime.client, runtime.accountClient, runtime.deliveryBridge)
    : createParleMcpServer({} as ParleMcpClientLike, new ParleAccountClient(), undefined, {
        error: configError!,
        recover: createRuntime,
        onRecovered(recovered) {
          activateRuntime(recovered as ReturnType<typeof createRuntime>);
        },
      }, process.env.PARLE_EXPOSE_DEGRADED_TOOLS === "1");
  await server.connect(new StdioServerTransport());
  if (runtime) activateRuntime(runtime);
}

type EagerBootstrapTimer = ReturnType<typeof setTimeout>;
type EagerBootstrapOptions = {
  setTimer?: (callback: () => void, delayMs: number) => EagerBootstrapTimer;
  clearTimer?: (timer: EagerBootstrapTimer) => void;
  now?: () => number;
  onError?: (error: unknown) => void;
};

export function scheduleEagerBootstrap(client: ParleAgentClient, deliveryBridge?: HookDeliveryBridge, options: EagerBootstrapOptions = {}): () => void {
  const setTimer = options.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
  const now = options.now || (() => Date.now());
  let timer: EagerBootstrapTimer | undefined;
  let stopped = false;
  let running = false;
  let attempts = 0;
  const maxAttempts = 5;

  const schedule = (delayMs: number) => {
    if (stopped || attempts >= maxAttempts) return;
    const delay = Math.min(Math.max(1, delayMs), 2_147_483_647);
    timer = setTimer(() => {
      timer = undefined;
      void arm().catch(options.onError || (() => undefined));
    }, delay);
    timer.unref?.();
  };

  const arm = async () => {
    if (stopped || running || attempts >= maxAttempts) return;
    running = true;
    attempts += 1;
    try {
      await client.ensureReadySafe();
      if (stopped) return;
      if (client.runtime.bootstrapped) {
        if (deliveryBridge) {
          void deliveryBridge.start().catch((error) => {
            options.onError?.(error);
            schedule(1_000 * (2 ** Math.min(attempts - 1, 6)));
          });
        }
        return;
      }
      const retryAt = client.runtime.nextRetryAt ? Date.parse(client.runtime.nextRetryAt) : Number.NaN;
      if (client.runtime.bootstrapState !== "failed" || !Number.isFinite(retryAt)) return;
      const retryDelay = retryAt - now();
      schedule(retryDelay > 0 ? retryDelay : 1_000);
    } catch (error) {
      options.onError?.(error);
      schedule(1_000 * (2 ** Math.min(attempts - 1, 6)));
    } finally {
      running = false;
    }
  };

  void arm();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = undefined;
  };
}

function installLifecycleHandlers(client: ParleAgentClient, deliveryBridge?: HookDeliveryBridge, stopEagerBootstrap: () => void = () => {}) {
  let ending = false;
  const shutdown = () => {
    if (ending) return;
    ending = true;
    stopEagerBootstrap();
    const timer = setTimeout(() => process.exit(0), 2000);
    void deliveryBridge?.stop().catch(() => {}).then(() => client.endSession()).catch(() => {}).finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // exit allows no async work; drop the runtime file so readers never see a
  // dead-pid snapshot longer than necessary. Session end over the network is
  // the SIGINT/SIGTERM path's job.
  process.on("exit", () => client.discardRuntimeFile());
}

export function isDirectRun(metaUrl: string, argvPath = process.argv[1]): boolean {
  return Boolean(argvPath) && metaUrl === pathToFileURL(argvPath).href;
}

export function resolveWatcherEnvironment(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, onWarning?: (warning: string) => void, profile?: string): NodeJS.ProcessEnv {
  const selectedEnv = profile ? { ...env, PARLE_PROFILE: profile } : env;
  const config = resolveConfig(cwd, selectedEnv);
  for (const warning of config.warnings) onWarning?.(redactString(warning));
  const roomId = config.roomId?.value;
  const agentToken = config.agentToken?.value;
  if (!roomId || !agentToken) {
    throw new Error("required host configuration is missing. Set PARLE_PROFILE (profile catalog; PARLE_PROFILES_PATH relocates it) or PARLE_ROOM_ID / PARLE_ROOM_AGENT_TOKEN in env or ./.env (run from the project directory)");
  }
  // The child receives fully resolved direct values; drop the selector and
  // catalog-path settings so it cannot re-resolve against a different catalog.
  const childEnv = { ...selectedEnv };
  delete childEnv.PARLE_PROFILE;
  delete childEnv.PARLE_PROFILES_PATH;
  return {
    ...childEnv,
    PARLE_API_BASE: config.apiBase.value,
    PARLE_WAKE_BASE: config.wakeBase.value,
    PARLE_VERSION: config.version.value,
    PARLE_ROOM_ID: roomId,
    PARLE_ROOM_AGENT_TOKEN: agentToken,
    PARLE_WATCH_CLIENT_INSTANCE_ID: MCP_CLIENT_INSTANCE_ID,
  };
}

export const WATCHER_USAGE = "Usage: parle-watch.sh [--profile <name>] <since_seq> [my_agent_session_id [my_participant_id]]";

export class WatcherUsageError extends Error {
  constructor() {
    super(WATCHER_USAGE);
    this.name = "WatcherUsageError";
  }
}

export function watcherExitRequiresInternalRestart(spawnRevision: number, desiredRevision: number, requestedRevision?: number): boolean {
  return requestedRevision !== undefined && requestedRevision > spawnRevision && requestedRevision <= desiredRevision;
}

export function parseWatcherArgs(args: string[]): { profile?: string; workerArgs: [string] | [string, string] | [string, string, string] } {
  let profile: string | undefined;
  let positional = args;
  if (args[0]?.startsWith("-")) {
    if (args[0] !== "--profile" || !args[1] || args[1].startsWith("-")) throw new WatcherUsageError();
    profile = args[1];
    positional = args.slice(2);
  }
  // since_seq is decimal digits only. Leading zeroes are accepted and retain
  // the shell worker's existing numeric semantics. Participant identity is
  // nested under session identity so no ambiguous participant-only form exists.
  if (positional.length < 1 || positional.length > 3 || !/^[0-9]+$/.test(positional[0])
    || positional.slice(1).some((value) => !value || value.startsWith("-"))) throw new WatcherUsageError();
  return { ...(profile ? { profile } : {}), workerArgs: positional as [string] | [string, string] | [string, string, string] };
}

type WatcherEvidenceSink = Pick<ResponsiveDeliveryRecorder, "watching" | "backoff" | "stopped" | "terminal" | "retarget">;

export function reportResponsiveEvidence(operation: () => void, warn: (message: string) => void = console.error): boolean {
  try { operation(); return true; } catch (error) {
    warn(`Parle warning: responsive-delivery evidence unavailable: ${redactResponsiveDeliveryDiagnostic(error instanceof Error ? error.message : String(error)) || "redacted error"}`);
    return false;
  }
}

export function applyWatcherStateLine(line: string, evidence: WatcherEvidenceSink, nowMs = Date.now()): void {
  const [kind, value] = line.trim().split("\t", 2);
  if (kind === "watching") evidence.watching({ expectedProgressMs: 75_000, lastSuccessAt: new Date(nowMs).toISOString() });
  else if (kind === "backoff") {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) evidence.backoff({ expectedProgressMs: Math.min(seconds * 1000, 570_000), retryAt: new Date(nowMs + seconds * 1000).toISOString() });
  } else if (kind === "target" && value) evidence.retarget({ agentSessionId: value });
  else if (kind === "wake") evidence.stopped({ reason: "wake_detected", lastWakeAt: new Date(nowMs).toISOString() });
  else if (kind === "terminal") evidence.terminal({ reason: value || "watcher_terminal" });
}

export async function runWatcher(metaUrl: string, args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { profile, workerArgs } = parseWatcherArgs(args);
  const worker = join(dirname(fileURLToPath(metaUrl)), "..", "skills", "parle", "scripts", "parle-watch-worker.sh");
  if (!existsSync(worker)) throw new Error("bundled watcher worker is missing; reinstall or rebuild the Claude plugin");
  const childEnv = resolveWatcherEnvironment(cwd, env, (warning) => console.error(`Parle warning: ${warning}`), profile);
  // Shared rooms require the room-bound token and a live entered agent session.
  // The watcher owns a dedicated short-lived session so the primary MCP
  // credential never crosses the stdio process boundary. Its credential moves
  // only through a private child environment. Superseded credentials are
  // retired by rollover; the current session is retired on final exit.
  // Resolve the already-frozen direct binding away from the host cwd so a
  // project .env profile selector cannot conflict when this helper client
  // reads configuration a second time.
  // A watcher session is intentionally anonymous within the agent. It must
  // never claim or supersede the primary host's singleton named route.
  delete childEnv.PARLE_SESSION_ALIAS;
  childEnv.PARLE_UNREAD_POLL_INTERVAL_SECONDS = "0";
  const watcherClient = createMcpAgentClient({ cwd: dirname(fileURLToPath(metaUrl)), env: childEnv });
  const watchedAgentSessionId = workerArgs[1];
  const evidence = watchedAgentSessionId ? new ResponsiveDeliveryRecorder({
    cwd,
    persist: true,
    processStartedAt: processStartedAtIso(),
    publisher: { name: "@parlehq/mcp-server:standalone-watch", version: MCP_CLIENT_VERSION, clientInstanceId: MCP_CLIENT_INSTANCE_ID },
    target: { agentSessionId: watchedAgentSessionId, ...(workerArgs[2] ? { participantId: workerArgs[2] } : {}) },
  }) : undefined;
  const reportEvidence = (operation: () => void): void => { reportResponsiveEvidence(operation); };
  if (evidence) reportEvidence(() => evidence.starting({ expectedProgressMs: 75_000 }));
  let child: ReturnType<typeof spawn> | undefined;
  let childRevision = 0;
  let desiredRevision = 0;
  let externalSignal: NodeJS.Signals | undefined;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  let internalRestart: { child: ReturnType<typeof spawn>; revision: number } | undefined;
  const signalWorker = (target: ReturnType<typeof spawn>, signal: NodeJS.Signals): void => {
    // Give the shell and its current one-shot request helper one signal boundary.
    // A separate process group prevents an old helper from retaining a retired
    // credential after an internal worker restart.
    if (process.platform !== "win32" && target.pid) {
      try {
        process.kill(-target.pid, signal);
        return;
      } catch {}
    }
    target.kill(signal);
  };
  const stopWorker = (signal: NodeJS.Signals): boolean => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    const stoppingChild = child;
    signalWorker(stoppingChild, signal);
    if (!forceStop) {
      forceStop = setTimeout(() => {
        forceStop = undefined;
        signalWorker(stoppingChild, "SIGKILL");
      }, 1000);
      forceStop.unref();
    }
    return true;
  };
  const unsubscribeRevision = watcherClient.onSessionRevision((event) => {
    if (event.revision <= desiredRevision) return;
    desiredRevision = event.revision;
    if (!externalSignal && child && event.revision > childRevision && stopWorker("SIGTERM")) {
      // Provenance belongs to this exact live child. A revision by itself is
      // never enough to suppress a natural exit that already completed.
      internalRestart = { child, revision: event.revision };
    }
  });
  const forward = (signal: NodeJS.Signals) => {
    if (externalSignal) return;
    externalSignal = signal;
    stopWorker(signal);
  };
  try {
    await watcherClient.bootstrap();
    childEnv.PARLE_WATCH_REQUEST_HELPER = fileURLToPath(metaUrl);
    childEnv.PARLE_WATCH_PARENT_PID = String(process.pid);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    while (!externalSignal) {
      const spawnRevision = desiredRevision;
      const watcherAuth = watcherClient.watcherSessionAuth();
      const workerEnv = { ...childEnv, PARLE_WATCH_AGENT_SESSION: watcherAuth.sessionCredential };
      childRevision = spawnRevision;
      const launchedChild = spawn("sh", [worker, ...workerArgs], {
        cwd,
        env: { ...workerEnv, PARLE_WATCH_STATE_FD: "3" },
        stdio: ["inherit", "inherit", "inherit", "pipe"],
        detached: process.platform !== "win32",
      });
      child = launchedChild;
      if (evidence) reportEvidence(() => evidence.watching({ expectedProgressMs: 75_000 }));
      const stateStream = launchedChild.stdio[3] as import("node:stream").Readable | null;
      if (stateStream) {
        stateStream.setEncoding("utf8");
        let stateBuffer = "";
        stateStream.on("data", (chunk: string) => {
          stateBuffer += chunk;
          if (Buffer.byteLength(stateBuffer, "utf8") > 4096) {
            stateBuffer = "";
            stateStream.destroy();
            console.error("Parle warning: watcher state protocol exceeded 4096 bytes; continuing with spawn and exit evidence only");
            return;
          }
          let newline: number;
          while ((newline = stateBuffer.indexOf("\n")) >= 0) {
            const line = stateBuffer.slice(0, newline);
            stateBuffer = stateBuffer.slice(newline + 1);
            if (evidence) reportEvidence(() => applyWatcherStateLine(line, evidence));
          }
        });
      }
      let result: number;
      try {
        result = await new Promise<number>((resolve, reject) => {
          launchedChild.once("error", reject);
          launchedChild.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 2)));
        });
      } finally {
        if (forceStop) clearTimeout(forceStop);
        forceStop = undefined;
        child = undefined;
      }
      const restartWasRequested = internalRestart?.child === launchedChild
        && watcherExitRequiresInternalRestart(spawnRevision, desiredRevision, internalRestart.revision);
      if (internalRestart?.child === launchedChild) internalRestart = undefined;
      if (externalSignal) {
        if (evidence) reportEvidence(() => evidence.stopped({ reason: "host_signal" }));
        return result;
      }
      if (restartWasRequested) {
        // The worker cursor is private in-memory shell state. Replaying the
        // original since_seq after this daily credential rollover is safe:
        // projection filtering is idempotent and the public argv stays stable.
        continue;
      }
      if (evidence) {
        if (result === 0) reportEvidence(() => evidence.stopped({ reason: "wake_detected" }));
        else if (evidence.snapshot()?.state !== "terminal") reportEvidence(() => evidence.terminal({ reason: `watcher_exit_${result}` }));
      }
      return result;
    }
    if (evidence) reportEvidence(() => evidence.stopped({ reason: "host_signal" }));
    return 128;
  } finally {
    unsubscribeRevision();
    if (forceStop) clearTimeout(forceStop);
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
    if (child && child.exitCode === null && child.signalCode === null) signalWorker(child, "SIGKILL");
    await watcherClient.endSession().catch(() => {});
  }
}

type WatcherRequestOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  parentPid?: number;
};

type WatcherRequestMode = "hold" | "probe";

function watcherLocalWire(outcome: "held_deadline" | "network_failure" | "malformed_response" | "parent_gone"): string {
  return `000\n${JSON.stringify({ watcher_local: { outcome } })}`;
}

export async function watcherRequestWire(since: string, mode: WatcherRequestMode = "hold", options: WatcherRequestOptions = {}): Promise<string> {
  if (mode !== "hold" && mode !== "probe") throw new Error("watch request mode must be hold or probe");
  const env = options.env ?? process.env;
  const apiBase = env.PARLE_API_BASE;
  const roomId = env.PARLE_ROOM_ID;
  const token = env.PARLE_ROOM_AGENT_TOKEN;
  const sessionCredential = env.PARLE_WATCH_AGENT_SESSION;
  const version = env.PARLE_VERSION;
  const clientInstanceId = env.PARLE_WATCH_CLIENT_INSTANCE_ID;
  if (!apiBase || !roomId || !token || !sessionCredential || !version || !clientInstanceId) throw new Error("watch request configuration is missing");
  const url = new URL(`/v/rooms/${encodeURIComponent(roomId)}/projection`, apiBase);
  url.searchParams.set("since_seq", since);
  url.searchParams.set("wait", mode === "probe" ? "0" : "25");
  const controller = new AbortController();
  let helperDeadline = false;
  let parentGone = false;
  const timeoutMs = options.timeoutMs ?? (mode === "probe" ? 10_000 : 40_000);
  const timer = setTimeout(() => {
    helperDeadline = true;
    controller.abort();
  }, timeoutMs);
  const parentPid = options.parentPid ?? Number(env.PARLE_WATCH_PARENT_PID);
  const parentMonitor = Number.isInteger(parentPid) && parentPid > 0 ? setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      parentGone = true;
      controller.abort();
    }
  }, 500) : undefined;
  parentMonitor?.unref();
  const integration = resolveIntegrationMetadata(env);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Parle-Agent-Session": sessionCredential,
        "Parle-Version": version,
        "Parle-Client-Name": MCP_CLIENT_NAME,
        "Parle-Client-Version": MCP_CLIENT_VERSION,
        "Parle-Client-Instance": clientInstanceId,
        ...(integration.integrationName ? { "Parle-Integration-Name": integration.integrationName } : {}),
        ...(integration.integrationVersion ? { "Parle-Integration-Version": integration.integrationVersion } : {}),
        Connection: "close",
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    const withoutSecrets = raw.split(token).join("<redacted>").split(sessionCredential).join("<redacted>");
    const body = redactString(withoutSecrets);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return watcherLocalWire("malformed_response");
    }
    if (response.ok) {
      const projection = parsed as { messages?: unknown; watermark?: unknown } | null;
      if (!projection || typeof projection !== "object" || Array.isArray(projection)
        || !Array.isArray(projection.messages)
        || !Number.isInteger(projection.watermark) || (projection.watermark as number) < 0) {
        return watcherLocalWire("malformed_response");
      }
    }
    return `${response.status}\n${body}`;
  } catch {
    if (parentGone) return watcherLocalWire("parent_gone");
    if (helperDeadline && mode === "hold") return watcherLocalWire("held_deadline");
    return watcherLocalWire("network_failure");
  } finally {
    clearTimeout(timer);
    if (parentMonitor) clearInterval(parentMonitor);
  }
}

async function runWatcherRequest(since: string, mode: string): Promise<void> {
  if (mode !== "hold" && mode !== "probe") throw new Error("watch request mode must be hold or probe");
  const wire = await watcherRequestWire(since, mode);
  await new Promise<void>((resolve) => process.stdout.write(wire, () => resolve()));
}

async function runKnownAddressContext(cwd: string): Promise<void> {
  const cfg = resolveConfig(cwd, process.env);
  if (!cfg.apiBase.value || !cfg.roomId?.value) return;
  let profilesPathOverride = process.env.PARLE_PROFILES_PATH;
  if (!profilesPathOverride) {
    try {
      profilesPathOverride = parseKeyValueFile(readFileSync(join(cwd, ".env"), "utf8")).PARLE_PROFILES_PATH;
    } catch {}
  }
  const catalog = resolveProfileCatalogPath(profilesPathOverride, cwd, process.env);
  const block = knownAddressContextFor(catalog, { apiBase: cfg.apiBase.value, roomId: cfg.roomId.value });
  await new Promise<void>((resolve) => process.stdout.write(block, () => resolve()));
}

if (isDirectRun(import.meta.url)) {
  const command = process.argv[2];
  const isRequest = command === "--parle-watch-request";
  const task = command === "--parle-watch"
    ? runWatcher(import.meta.url, process.argv.slice(3)).then((code) => { process.exitCode = code; })
    : isRequest
      ? runWatcherRequest(process.argv[3] ?? "0", process.argv[4] ?? "hold")
      : command === "--parle-known-address-context"
        ? runKnownAddressContext(process.argv[3] || process.cwd())
        : runStdio();
  task.then(() => {
    // Node's global fetch keeps an idle connection alive. The one-shot private
    // request helper has flushed stdout and must not linger after each poll.
    if (isRequest) process.exit(0);
  }).catch((error) => {
    if (error instanceof WatcherUsageError) console.error(WATCHER_USAGE);
    else console.error(`Parle stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
