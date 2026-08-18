#!/usr/bin/env node
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { INBOX_COMPLETENESS_GUIDANCE, INBOX_REPLY_GUIDANCE, SEND_ATTENTION_GUIDANCE, ParleAccountClient, ParleAgentClient, ParleApiError, ProfileConfigError, ProfileNotFoundError, ReadParams, SendParams, SubmitReplyParams, activeRoomSectionFromStatus, assertClientName, assertClientVersion, compactConnectionCardFromSummary, compactStatusCardFromStatus, inspectResponsiveDeliveryPid, processClientInstanceId, readResponsiveDeliverySnapshots, redactString, resolveConfig, resolveResponsiveDelivery, type AcceptRoomInvitationParams, type ActiveRoomInventoryRow, type AddOwnAgentSeatParams, type ClaimPrincipalInviteParams, type ClientOptions, type ConnectOwnAgentParams, type CreateRoomParams, type HardenAccountParams, type LoginParams, type MintPrincipalInviteParams, type OwnedAliasDeliveryParams, type OwnedAliasReleaseParams, type ParleRoomsInventory, type RoomInventorySection, knownAddressContextFor, parseKeyValueFile, resolveProfileCatalogPath } from "@parlehq/agent-client";
import { HookDeliveryBridge, hookBridgeStateDir } from "./hook-delivery-bridge.js";
import { registerParleTools, type DegradedMcpBoot, type HookDeliveryBridgeLike, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";
export { hostSessionIdFromMeta, registerParleTools, type DegradedMcpBoot, type HookDeliveryBridgeLike, type ParleAccountClientLike, type ParleMcpClientLike, type RegisterParleTool } from "./tool-runtime.js";

export const MCP_CLIENT_NAME = "@parlehq/mcp-server";
export const MCP_CLIENT_VERSION = "0.7.43";
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
  const createRuntime = () => {
    const clientEnv = hookBridgeEnabled ? { ...process.env, PARLE_UNREAD_POLL_INTERVAL_SECONDS: "0" } : process.env;
    const client = createMcpAgentClient({ env: clientEnv, publishRuntime: { adapterName: MCP_CLIENT_NAME, adapterVersion: MCP_CLIENT_VERSION } });
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
        hostProcessMode === "direct-parent" ? process.ppid : undefined,
      )
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
        cwd: process.cwd(),
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

export async function runWatcher(_metaUrl: string, args: string[], cwd = process.cwd()): Promise<number> {
  const agentSessionId = parseWatcherArgs(args);
  const stateDir = hookBridgeStateDir(cwd);
  const state = lstatSync(stateDir);
  if (!state.isDirectory() || state.isSymbolicLink()
    || (typeof process.getuid === "function" && state.uid !== process.getuid())
    || (state.mode & 0o077) !== 0) {
    throw new Error(`Unsafe Parle hook bridge directory: ${stateDir}`);
  }
  const entries = readdirSync(stateDir, { withFileTypes: true });
  const paths = [
    ...entries.filter((entry) => /^\d+\.sock$/.test(entry.name)).map((entry) => join(stateDir, entry.name)),
    ...entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .flatMap((entry) => {
        const parentDir = join(stateDir, entry.name);
        const parentState = lstatSync(parentDir);
        if (parentState.isSymbolicLink()
          || (typeof process.getuid === "function" && parentState.uid !== process.getuid())
          || (parentState.mode & 0o077) !== 0) return [];
        return readdirSync(parentDir)
          .filter((name) => /^\d+\.sock$/.test(name))
          .map((name) => join(parentDir, name));
      }),
  ];
  for (const path of paths) {
    try {
      const status = await hookBridgeRequest(path, { action: "status" }, HOOK_BRIDGE_REQUEST_TIMEOUT_MS);
      if (!status?.ok || !status.running || !status.hostSessionBound || status.agentSessionId !== agentSessionId) continue;
      const result = await hookBridgeRequest(path, { action: "wait", agentSessionId });
      if (!result?.ok || !result.ready) throw new Error(result?.error || "Parle hook bridge wait failed");
      console.log("parle-watch: responsive delivery queued");
      return 0;
    } catch (error: any) {
      if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error?.code)) continue;
      throw error;
    }
  }
  throw new Error(`No live Parle hook bridge owns agent session ${agentSessionId}. Run parle_connect in this project, then re-arm with its current agent session id.`);
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
