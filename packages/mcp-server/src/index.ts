#!/usr/bin/env node
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { INBOX_COMPLETENESS_GUIDANCE, INBOX_REPLY_GUIDANCE, SEND_ATTENTION_GUIDANCE, ParleAccountClient, ParleAgentClient, ParleApiError, ProfileConfigError, ProfileNotFoundError, ReadParams, SendParams, SubmitReplyParams, activeRoomSectionFromStatus, assertClientName, assertClientVersion, compactConnectionCardFromSummary, compactStatusCardFromStatus, inspectResponsiveDeliveryPid, processClientInstanceId, readResponsiveDeliverySnapshots, redactString, resolveConfig, resolveResponsiveDelivery, type AcceptRoomInvitationParams, type ActiveRoomInventoryRow, type AddOwnAgentSeatParams, type ClaimPrincipalInviteParams, type ClientOptions, type ConnectOwnAgentParams, type CreateRoomParams, type HardenAccountParams, type LoginParams, type MintPrincipalInviteParams, type OwnedAliasDeliveryParams, type OwnedAliasReleaseParams, type ParleRoomsInventory, type RoomInventorySection, knownAddressContextFor, parseKeyValueFile, resolveProfileCatalogPath } from "@parlehq/agent-client";
import { HookDeliveryBridge, hookBridgeStateDir, processIsAlive, removeDeadHookBridgeArtifact } from "./hook-delivery-bridge.js";
import { registerParleTools, type ConfigCwdSource, type DegradedMcpBoot, type HookDeliveryBridgeLike, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";
export { hostSessionIdFromMeta, registerParleTools, type ConfigCwdSource, type DegradedMcpBoot, type HookDeliveryBridgeLike, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";

export const MCP_CLIENT_NAME = "@parlehq/mcp-server";
export const MCP_CLIENT_VERSION = "0.7.60";
export const MCP_CLIENT_INSTANCE_ID = processClientInstanceId();

export function resolveIntegrationMetadata(env: Record<string, string | undefined> = process.env): Pick<ClientOptions, "integrationName" | "integrationVersion"> {
  const rawName = env.PARLE_INTEGRATION_NAME;
  const rawVersion = env.PARLE_INTEGRATION_VERSION;
  if (rawVersion && !rawName) throw new Error("PARLE_INTEGRATION_VERSION requires PARLE_INTEGRATION_NAME.");
  return {
    integrationName: rawName ? assertClientName(rawName) : undefined,
    integrationVersion: rawVersion ? assertClientVersion(rawVersion) : undefined,
  };
}

export type ConfigCwd = { cwd: string; source: ConfigCwdSource };

// Hosts that spawn the server from an install directory (Codex sets cwd to the
// plugin cache) still forward PWD, the shell launch directory. Only a host
// manifest that opts in with PARLE_CONFIG_CWD_FROM_PWD=1 lets configuration
// resolution (the project .env, a relative PARLE_PROFILES_PATH) follow PWD, and
// then only when it is an absolute, existing, realpath-stable directory. Other
// hosts (Claude Code runs the server in the project; Claude Desktop is
// GUI-launched with an unrelated PWD) keep the process directory.
export function resolveConfigCwd(env: Record<string, string | undefined> = process.env, fallback = process.cwd()): ConfigCwd {
  const pwd = env.PWD;
  if (env.PARLE_CONFIG_CWD_FROM_PWD === "1" && pwd && isAbsolute(pwd)) {
    try {
      const resolved = realpathSync(pwd);
      if (statSync(resolved).isDirectory()) return { cwd: resolved, source: "PWD" };
    } catch {
      // An unresolvable PWD is not a configuration directory.
    }
  }
  return { cwd: fallback, source: "process.cwd" };
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
  const hostProcessMode = process.env.PARLE_HOOK_BRIDGE_HOST_PROCESS;
  if (hostProcessMode && hostProcessMode !== "direct-parent") {
    throw new Error(`Unsupported PARLE_HOOK_BRIDGE_HOST_PROCESS mode: ${hostProcessMode}`);
  }
  const hostParentPid = hostProcessMode === "direct-parent" ? process.ppid : undefined;
  const configCwd = resolveConfigCwd();
  let stopPreRuntimeParentCheck = hostParentPid === undefined
    ? () => {}
    : scheduleHostParentCheck(hostParentPid, () => process.exit(0));
  const createRuntime = () => {
    const clientEnv = hookBridgeEnabled ? { ...process.env, PARLE_UNREAD_POLL_INTERVAL_SECONDS: "0" } : process.env;
    const client = createMcpAgentClient({ cwd: configCwd.cwd, env: clientEnv, publishRuntime: { adapterName: MCP_CLIENT_NAME, adapterVersion: MCP_CLIENT_VERSION } });
    if (hookBridgeEnabled) {
      client.switchProfile = async () => {
        throw new Error("Live Parle profile switching is unavailable while the hook bridge owns responsive delivery. Restart the host with the target PARLE_PROFILE so the MCP session, wake stream, queue, and hook binding change atomically.");
      };
    }
    const deliveryBridge = hookBridgeEnabled
      ? new HookDeliveryBridge(
        client,
        process.env.PARLE_HOOK_BRIDGE_SCOPE || process.cwd(),
        process.execPath,
        process.cwd(),
        hostParentPid,
      )
      : undefined;
    const baseStatus = client.status.bind(client);
    client.status = () => ({
      ...baseStatus(),
      configCwd: configCwd.cwd,
      configCwdSource: configCwd.source,
      ...(deliveryBridge ? { responsiveDeliveryBridge: deliveryBridge.status() } : {}),
    });
    return { client, accountClient: new ParleAccountClient({ cwd: configCwd.cwd }), deliveryBridge };
  };
  let activated = false;
  const activateRuntime = (runtime: ReturnType<typeof createRuntime>) => {
    if (activated) return;
    activated = true;
    stopPreRuntimeParentCheck();
    stopPreRuntimeParentCheck = () => {};
    // Eager background bootstrap creates the session before the first tool call.
    // A retryable startup failure arms one unreferenced deadline at a time from
    // the shared client's server-derived nextRetryAt. Terminal or unconfigured
    // states have no retry deadline and therefore schedule no automatic work.
    const stopEagerBootstrap = scheduleEagerBootstrap(runtime.client, runtime.deliveryBridge, {
      onError(error) {
        console.error(`Parle hook delivery bridge stopped: ${redactString(error instanceof Error ? error.message : String(error))}`);
      },
    });
    installLifecycleHandlers(runtime.client, runtime.deliveryBridge, stopEagerBootstrap, hostParentPid);
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
        cwd: configCwd.cwd,
        cwdSource: configCwd.source,
        env: process.env,
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

type HostParentCheckOptions = {
  readParentPid?: () => number;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
};

export function scheduleHostParentCheck(expectedPid: number, shutdown: () => void, options: HostParentCheckOptions = {}): () => void {
  const readParentPid = options.readParentPid || (() => process.ppid);
  const setCheckInterval = options.setInterval || ((callback, delayMs) => setInterval(callback, delayMs));
  const clearCheckInterval = options.clearInterval || ((timer) => clearInterval(timer));
  let stopped = false;
  const timer = setCheckInterval(() => {
    if (stopped || readParentPid() === expectedPid) return;
    stopped = true;
    clearCheckInterval(timer);
    shutdown();
  }, 5_000);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearCheckInterval(timer);
  };
}

function installLifecycleHandlers(client: ParleAgentClient, deliveryBridge?: HookDeliveryBridge, stopEagerBootstrap: () => void = () => {}, hostParentPid?: number) {
  let ending = false;
  let stopHostParentCheck = () => {};
  const shutdown = () => {
    if (ending) return;
    ending = true;
    stopHostParentCheck();
    stopEagerBootstrap();
    const timer = setTimeout(() => process.exit(0), 2000);
    void deliveryBridge?.stop().catch(() => {}).then(() => client.endSession()).catch(() => {}).finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };
  if (hostParentPid !== undefined) stopHostParentCheck = scheduleHostParentCheck(hostParentPid, shutdown);
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

export const WATCHER_USAGE = "Usage: parle-watch.sh <agent_session_id>";

export class WatcherUsageError extends Error {
  constructor() {
    super(WATCHER_USAGE);
    this.name = "WatcherUsageError";
  }
}

export function parseWatcherArgs(args: string[]): string {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) throw new WatcherUsageError();
  return args[0];
}

const HOOK_BRIDGE_REQUEST_TIMEOUT_MS = 1000;

function hookBridgeRequest(path: string, payload: unknown, timeoutMs = 0): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setEncoding("utf8");
    if (timeoutMs > 0) socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error("Parle hook bridge request timed out"), { code: "ETIMEDOUT" })));
    let response = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > 16 * 1024) {
        socket.destroy(new Error("Parle hook bridge response exceeded 16 KiB"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(response.slice(0, newline)));
      } catch {
        reject(new Error("Parle hook bridge returned malformed JSON"));
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (!response.includes("\n")) reject(new Error("Parle hook bridge closed without a response"));
    });
  });
}

type WatcherDependencies = {
  stateDir?: string;
  request?: typeof hookBridgeRequest;
  isProcessAlive?: typeof processIsAlive;
  lstat?: typeof lstatSync;
};

export async function runWatcher(_metaUrl: string, args: string[], cwd = process.cwd(), dependencies: WatcherDependencies = {}): Promise<number> {
  const agentSessionId = parseWatcherArgs(args);
  const stateDir = dependencies.stateDir || hookBridgeStateDir(cwd);
  const request = dependencies.request || hookBridgeRequest;
  const isProcessAlive = dependencies.isProcessAlive || processIsAlive;
  const lstat = dependencies.lstat || lstatSync;
  const state = lstat(stateDir);
  if (!state.isDirectory() || state.isSymbolicLink()
    || (typeof process.getuid === "function" && state.uid !== process.getuid())
    || (state.mode & 0o077) !== 0) {
    throw new Error(`Unsafe Parle hook bridge directory: ${stateDir}`);
  }
  const entries = readdirSync(stateDir, { withFileTypes: true });
  const discoveryErrors = new Map<string, number>();
  const recordDiscoveryError = (error: any) => {
    const code = typeof error?.code === "string" && error.code ? error.code : "UNKNOWN";
    discoveryErrors.set(code, (discoveryErrors.get(code) || 0) + 1);
  };
  const currentPaths = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .flatMap((entry) => {
      const parentDir = join(stateDir, entry.name);
      let parentState;
      try { parentState = lstat(parentDir); } catch (error) {
        recordDiscoveryError(error);
        return [];
      }
      if (parentState.isSymbolicLink()
        || (typeof process.getuid === "function" && parentState.uid !== process.getuid())
        || (parentState.mode & 0o077) !== 0) return [];
      return readdirSync(parentDir)
        .filter((name) => /^\d+\.sock$/.test(name))
        .map((name) => join(parentDir, name));
    })
    .sort();
  // Flat sockets predate host-pid isolation. Keep live ones as a compatibility
  // fallback, but never let dead legacy processes block current candidates.
  const legacyPaths = entries
    .filter((entry) => /^\d+\.sock$/.test(entry.name))
    .flatMap((entry) => {
      const path = join(stateDir, entry.name);
      if (removeDeadHookBridgeArtifact(path, entry.name, false, undefined, { lstat, processIsAlive: isProcessAlive })) return [];
      let socketState;
      try { socketState = lstat(path); } catch (error) {
        recordDiscoveryError(error);
        return [];
      }
      if (socketState.isSymbolicLink()
        || (typeof process.getuid === "function" && socketState.uid !== process.getuid())
        || (socketState.mode & 0o077) !== 0) return [];
      return [path];
    })
    .sort();
  const paths = [...currentPaths, ...legacyPaths];
  const probeErrors = new Map<string, number>();
  for (const path of paths) {
    let status;
    try {
      status = await request(path, { action: "status" }, HOOK_BRIDGE_REQUEST_TIMEOUT_MS);
    } catch (error: any) {
      const code = typeof error?.code === "string" && error.code ? error.code : "UNKNOWN";
      probeErrors.set(code, (probeErrors.get(code) || 0) + 1);
      continue;
    }
    if (!status?.ok || !status.running || !status.hostSessionBound || status.agentSessionId !== agentSessionId) continue;
    if (status.waiterAttached === true) {
      console.log("parle-watch: local delivery waiter already attached");
      return 0;
    }
    const result = await request(path, { action: "wait", agentSessionId });
    if (result?.ok && result.alreadyAttached === true) {
      console.log("parle-watch: local delivery waiter already attached");
      return 0;
    }
    // Compatibility with an older bridge during a plugin update.
    if (result?.error === "Parle hook bridge already has a waiter") {
      console.log("parle-watch: local delivery waiter already attached");
      return 0;
    }
    if (!result?.ok || !result.ready) throw new Error(result?.error || "Parle hook bridge wait failed");
    console.log("parle-watch: responsive delivery queued");
    return 0;
  }
  const discoveryDetail = discoveryErrors.size === 0 ? "none" : [...discoveryErrors].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code} (${count})`).join(", ");
  const detail = paths.length === 0
    ? `Found 0 candidate sockets; discovery errors: ${discoveryDetail}.`
    : `Probed ${paths.length} candidate socket${paths.length === 1 ? "" : "s"}; discovery errors: ${discoveryDetail}; status probe errors: ${probeErrors.size === 0 ? "none" : [...probeErrors].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code} (${count}/${paths.length})`).join(", ")}.`;
  throw new Error(`No live Parle hook bridge owns agent session ${agentSessionId}. ${detail} Run parle_connect in this project, then re-arm with its current agent session id.`);
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
  const task = command === "--parle-watch"
    ? runWatcher(import.meta.url, process.argv.slice(3)).then((code) => { process.exitCode = code; })
    : command === "--parle-known-address-context"
      ? runKnownAddressContext(process.argv[3] || process.cwd())
      : runStdio();
  task.catch((error) => {
    if (error instanceof WatcherUsageError) console.error(WATCHER_USAGE);
    else console.error(`Parle stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
