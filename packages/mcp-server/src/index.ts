#!/usr/bin/env node
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { INBOX_COMPLETENESS_GUIDANCE, INBOX_REPLY_GUIDANCE, SEND_ATTENTION_GUIDANCE, ParleAccountClient, ParleAgentClient, ParleApiError, ProfileConfigError, ProfileNotFoundError, ReadParams, SendParams, SubmitReplyParams, activeRoomSectionFromStatus, assertClientName, assertClientVersion, compactConnectionCardFromSummary, compactStatusCardFromStatus, inspectResponsiveDeliveryPid, processClientInstanceId, readResponsiveDeliverySnapshots, redactString, resolveConfig, resolveResponsiveDelivery, type AcceptRoomInvitationParams, type ActiveRoomInventoryRow, type AddOwnAgentSeatParams, type ClaimPrincipalInviteParams, type ClientOptions, type ConnectOwnAgentParams, type CreateRoomParams, type HardenAccountParams, type LoginParams, type MintPrincipalInviteParams, type OwnedAliasDeliveryParams, type OwnedAliasReleaseParams, type ParleRoomsInventory, type RoomInventorySection, knownAddressContextFor, parseKeyValueFile, resolveProfileCatalogPath } from "@parlehq/agent-client";
import { ClaudeMonitorWake } from "./claude-monitor-wake.js";
import { CodexQueueWake } from "./codex-host.js";
import { HookDeliveryBridge, type HostIdleWake } from "./hook-delivery-bridge.js";
import { registerParleTools, type ConfigCwdSource, type DegradedMcpBoot, type HookDeliveryBridgeLike, type McpHostCapabilities, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";
export { hostSessionIdFromMeta, registerParleTools, type ConfigCwdSource, type DegradedMcpBoot, type HookDeliveryBridgeLike, type IdleWakeState, type McpHostCapabilities, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";
export { CODEX_QUEUE_WAKE_TRIGGER, CodexQueueWake, MIN_CODEX_QUEUE_VERSION, resolveCodexHostExecutable } from "./codex-host.js";
export { CLAUDE_MONITOR_WAKE_FRAME, ClaudeMonitorWake } from "./claude-monitor-wake.js";

export const MCP_CLIENT_NAME = "@parlehq/mcp-server";
export const MCP_CLIENT_VERSION = "0.7.66";
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
  host: McpHostCapabilities = {},
) {
  const server = new McpServer({ name: "parle-mcp-server", version: MCP_CLIENT_VERSION });
  registerParleTools(
    ((...args: any[]) => (server.registerTool as any)(...args)) as RegisterParleTool,
    client,
    accountClient,
    deliveryBridge,
    degradedBoot,
    exposeDegradedTools,
    host,
  );
  return server;
}

// A host manifest declares `PARLE_HOST_IDLE_WAKE=none` when it has no idle-wake
// arm action, `codex-queue` when the bridge may start an idle turn through
// the owning Codex process's queue, or `claude-monitor` when the host attaches
// its Monitor tool to the bridge's loopback wake socket; absent means the host
// may arm one through its own hooks.
export function resolveHostCapabilities(env: Record<string, string | undefined> = process.env): McpHostCapabilities {
  const idleWake = env.PARLE_HOST_IDLE_WAKE;
  if (!idleWake) return {};
  if (idleWake !== "none" && idleWake !== "codex-queue" && idleWake !== "claude-monitor") throw new Error(`Unsupported PARLE_HOST_IDLE_WAKE mode: ${idleWake}`);
  return { idleWake };
}

// Queue wake needs the owning host process: without direct-parent correlation
// there is no verified executable to call, so the bridge reports the
// capability as unavailable rather than guessing. The monitor wake needs only
// the bridge, whose owner-only socket hands the host the address.
export function createHostIdleWake(host: McpHostCapabilities, hookBridgeEnabled: boolean, hostParentPid?: number): HostIdleWake | undefined {
  if (!hookBridgeEnabled) return undefined;
  if (host.idleWake === "codex-queue") return hostParentPid === undefined ? undefined : new CodexQueueWake(hostParentPid);
  if (host.idleWake === "claude-monitor") return new ClaudeMonitorWake();
  return undefined;
}

export async function runStdio() {
  const responsiveDelivery = process.env.PARLE_RESPONSIVE_DELIVERY;
  if (responsiveDelivery && responsiveDelivery !== "hook-bridge") {
    throw new Error(`Unsupported PARLE_RESPONSIVE_DELIVERY mode: ${responsiveDelivery}`);
  }
  const host = resolveHostCapabilities();
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
    const idleWake = createHostIdleWake(host, hookBridgeEnabled, hostParentPid);
    const deliveryBridge = hookBridgeEnabled
      ? new HookDeliveryBridge(
        client,
        process.env.PARLE_HOOK_BRIDGE_SCOPE || process.cwd(),
        process.execPath,
        process.cwd(),
        hostParentPid,
        undefined,
        idleWake,
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
    ? createParleMcpServer(runtime.client, runtime.accountClient, runtime.deliveryBridge, undefined, false, host)
    : createParleMcpServer({} as ParleMcpClientLike, new ParleAccountClient(), undefined, {
        error: configError!,
        cwd: configCwd.cwd,
        cwdSource: configCwd.source,
        env: process.env,
        recover: createRuntime,
        onRecovered(recovered) {
          activateRuntime(recovered as ReturnType<typeof createRuntime>);
        },
      }, process.env.PARLE_EXPOSE_DEGRADED_TOOLS === "1", host);
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
  const task = command === "--parle-known-address-context"
    ? runKnownAddressContext(process.argv[3] || process.cwd())
    : runStdio();
  task.catch((error) => {
    console.error(`Parle stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
