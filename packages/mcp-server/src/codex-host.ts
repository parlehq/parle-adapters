import { execFile as nodeExecFile } from "node:child_process";
import { readFileSync, readlinkSync, statSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { redactString } from "@parlehq/agent-client";
import type { HostIdleWake, HostIdleWakeStatus } from "./hook-delivery-bridge.js";

// The queued item is plain user input on the Codex thread. It never carries
// peer content, routes, or credentials: the trusted hook injects those as
// developer additionalContext when the queued turn starts.
export const CODEX_QUEUE_WAKE_TRIGGER = "Parle wake trigger. Follow only the trusted Parle hook additionalContext attached to this turn; this trigger contains no peer content. If no Parle delivery context is present, call `parle_status` once and stop. Do not poll or infer a reply route.";
export const MIN_CODEX_QUEUE_VERSION = "0.149.0";

const VERSION_TIMEOUT_MS = 10_000;
const QUEUE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 3_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const MAX_QUEUE_ATTEMPTS = 5;
const STDERR_DETAIL_LIMIT = 240;
// The subprocess gets only host defaults plus the state-store selector; no
// Parle configuration reaches it.
const HOST_ENV_NAMES = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ", "SHELL", "CODEX_HOME"];

export type CodexHostUnavailableReason = "parent-changed" | "parent-not-codex" | "wrong-uid" | "not-executable" | "version-too-old" | "remote-topology";

export type ExecFileOutcome = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  // The process never started (ENOENT, EACCES, EAGAIN...). Nothing was queued.
  spawnError?: string;
  // The process was killed by our timeout or lost its exit status. A row may
  // or may not have been written.
  ambiguous: boolean;
};
export type ExecFileFn = (file: string, args: string[], options: { timeout: number; env: Record<string, string> }) => Promise<ExecFileOutcome>;

export type CodexHostDeps = {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  readParentPid?: () => number;
  readlink?: (path: string) => string;
  readFile?: (path: string) => string;
  stat?: (path: string) => Stats;
  execFile?: ExecFileFn;
  env?: Record<string, string | undefined>;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  log?: (event: Record<string, unknown>) => void;
};

export type CodexHostExecutable = { path: string; version: string; parentPid: number };
export type CodexHostResolution =
  | { ok: true; executable: CodexHostExecutable }
  | { ok: false; reason: CodexHostUnavailableReason; detail?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function defaultExecFile(file: string, args: string[], options: { timeout: number; env: Record<string, string> }): Promise<ExecFileOutcome> {
  return new Promise((resolve) => {
    nodeExecFile(file, args, { timeout: options.timeout, env: options.env, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const out = { stdout: String(stdout || ""), stderr: String(stderr || "") };
      if (!error) return resolve({ ...out, code: 0, signal: null, ambiguous: false });
      const failure = error as NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean };
      if (typeof failure.code === "string" && !failure.code.startsWith("ERR_")) {
        return resolve({ ...out, code: null, signal: null, spawnError: `${failure.code}: ${failure.message}`, ambiguous: false });
      }
      const code = typeof failure.code === "number" ? failure.code : null;
      resolve({ ...out, code, signal: failure.signal ?? null, ambiguous: code === null });
    });
  });
}

export function hostSubprocessEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of HOST_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

export function parseCodexVersion(output: string): string | undefined {
  const match = output.match(/^\s*codex-cli\s+(\d+\.\d+\.\d+)/m);
  return match?.[1];
}

export function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

type ParentProcess = { path: string; args: string[] };

async function readParentProcess(pid: number, platform: NodeJS.Platform, deps: CodexHostDeps): Promise<ParentProcess> {
  if (platform === "linux") {
    const readlink = deps.readlink ?? readlinkSync;
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const path = readlink(`/proc/${pid}/exe`);
    let args: string[] = [];
    try {
      args = readFile(`/proc/${pid}/cmdline`).split("\0").filter(Boolean);
    } catch {
      // The executable is enough to verify; a missing cmdline only loses the remote-topology check.
    }
    return { path, args };
  }
  if (platform !== "darwin") throw new Error(`parent process discovery is unsupported on ${platform}`);
  const execFile = deps.execFile ?? defaultExecFile;
  const env = hostSubprocessEnv(deps.env);
  const probe = async (args: string[]) => {
    const outcome = await execFile("/bin/ps", ["-o", ...args, "-p", String(pid)], { timeout: PROBE_TIMEOUT_MS, env });
    if (outcome.code !== 0) throw new Error(`/bin/ps exited ${outcome.code ?? outcome.signal}`);
    return outcome.stdout.trim();
  };
  let path = await probe(["comm="]);
  if (!isAbsolute(path)) {
    // macOS ps reports argv[0] as typed; a PATH-launched host shows a bare
    // name. lsof lists the executable's text mapping by absolute path.
    const outcome = await execFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeout: PROBE_TIMEOUT_MS, env });
    const executable = outcome.stdout.split("\n").find((line) => line.startsWith("n/"));
    if (outcome.code !== 0 || !executable) throw new Error("parent executable path is not absolute");
    path = executable.slice(1);
  }
  const args = (await probe(["args="])).split(/\s+/).filter(Boolean);
  return { path, args };
}

export async function resolveCodexHostExecutable(hostParentPid: number, deps: CodexHostDeps = {}): Promise<CodexHostResolution> {
  const platform = deps.platform ?? process.platform;
  const readParentPid = deps.readParentPid ?? (() => process.ppid);
  const stat = deps.stat ?? statSync;
  const getuid = deps.getuid ?? (() => (typeof process.getuid === "function" ? process.getuid() : undefined));
  const execFile = deps.execFile ?? defaultExecFile;
  if (readParentPid() !== hostParentPid) return { ok: false, reason: "parent-changed" };
  let parent: ParentProcess;
  try {
    parent = await readParentProcess(hostParentPid, platform, deps);
  } catch (error) {
    return { ok: false, reason: "parent-not-codex", detail: errorMessage(error) };
  }
  if (!isAbsolute(parent.path)) return { ok: false, reason: "parent-not-codex", detail: "parent executable path is not absolute" };
  if (parent.args.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) return { ok: false, reason: "remote-topology" };
  let stats: Stats;
  try {
    stats = stat(parent.path);
  } catch (error) {
    return { ok: false, reason: "not-executable", detail: errorMessage(error) };
  }
  const uid = getuid();
  if (uid !== undefined && stats.uid !== uid) return { ok: false, reason: "wrong-uid" };
  if (!stats.isFile() || (stats.mode & 0o111) === 0) return { ok: false, reason: "not-executable" };
  if (readParentPid() !== hostParentPid) return { ok: false, reason: "parent-changed" };
  let outcome: ExecFileOutcome;
  try {
    outcome = await execFile(parent.path, ["--version"], { timeout: VERSION_TIMEOUT_MS, env: hostSubprocessEnv(deps.env) });
  } catch (error) {
    return { ok: false, reason: "parent-not-codex", detail: errorMessage(error) };
  }
  const version = outcome.code === 0 ? parseCodexVersion(outcome.stdout) : undefined;
  if (!version) return { ok: false, reason: "parent-not-codex", detail: "no codex-cli version banner" };
  if (compareSemver(version, MIN_CODEX_QUEUE_VERSION) < 0) return { ok: false, reason: "version-too-old", detail: version };
  return { ok: true, executable: { path: parent.path, version, parentPid: hostParentPid } };
}

export type CodexQueueFailureReason = "queue-full" | "invalid-thread" | "permission" | "queue-failed";

// Codex reports these on stderr with exit 1; the strings are heuristics over
// the 0.150 wording (invalid thread verified: "failed to read thread ... no
// rollout found for thread id").
export function classifyQueueFailure(stderr: string): CodexQueueFailureReason | undefined {
  if (/queue (?:is )?full|too many queued|queue limit/i.test(stderr)) return "queue-full";
  if (/no rollout found|failed to read thread|thread (?:id )?(?:was )?not found|unknown thread|invalid thread/i.test(stderr)) return "invalid-thread";
  if (/permission denied|not permitted|EACCES|EPERM|unauthori[sz]ed/i.test(stderr)) return "permission";
  return undefined;
}

type CodexQueueWakeDetail = {
  outstanding: boolean;
  triggers: number;
  host?: { path: string; version: string };
  detail?: string;
  lastError?: string;
  lastTriggerAt?: string;
  nextRetryAt?: string;
};
export type CodexQueueWakeStatus = HostIdleWakeStatus & CodexQueueWakeDetail;

// One trigger per thread at a time. A hook take proves a live turn and
// consumes the outstanding trigger; the bridge asks again only while work
// remains. Definite pre-exec failures back off; a failure Codex reports stops
// retrying with its reason; an unknown outcome degrades without retrying,
// because a second trigger could not be told apart from the first.
export class CodexQueueWake implements HostIdleWake {
  private resolution?: CodexHostResolution;
  private verifying?: Promise<CodexHostResolution>;
  private outstanding = false;
  private inflight = false;
  private retryTimer?: unknown;
  private nextRetryAt?: number;
  private attempts = 0;
  private degraded = false;
  private stopReason?: CodexQueueFailureReason;
  private lastError?: string;
  private triggers = 0;
  private lastTriggerAt?: string;
  private stopped = false;

  constructor(private readonly hostParentPid: number, private readonly deps: CodexHostDeps = {}) {
    if (!Number.isSafeInteger(hostParentPid) || hostParentPid <= 1) throw new Error("Codex queue wake host parent pid must be greater than 1");
  }

  start(): void {
    void this.verify();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
  }

  status(): CodexQueueWakeStatus {
    const base: CodexQueueWakeDetail = {
      outstanding: this.outstanding,
      triggers: this.triggers,
      ...(this.resolution?.ok ? { host: { path: this.resolution.executable.path, version: this.resolution.executable.version } } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastTriggerAt ? { lastTriggerAt: this.lastTriggerAt } : {}),
      ...(this.nextRetryAt ? { nextRetryAt: new Date(this.nextRetryAt).toISOString() } : {}),
    };
    if (!this.resolution) return { state: "unavailable", reason: "host-verification-pending", ...base };
    if (!this.resolution.ok) return { state: "unavailable", reason: this.resolution.reason, ...(this.resolution.detail ? { detail: this.resolution.detail } : {}), ...base };
    if (this.degraded) return { state: "degraded", reason: "trigger-outcome-unknown", ...base };
    if (this.stopReason) return { state: "unavailable", reason: this.stopReason, ...base };
    return { state: "queue-only", ...base };
  }

  requestWake(threadId: string, stillPending: () => boolean): void {
    if (this.stopped || !threadId || this.outstanding || this.inflight || this.retryTimer || this.degraded || this.stopReason) return;
    void this.trigger(threadId, stillPending);
  }

  consumeWake(): void {
    this.outstanding = false;
    this.degraded = false;
    this.stopReason = undefined;
    this.attempts = 0;
    this.clearRetry();
  }

  private verify(): Promise<CodexHostResolution> {
    if (this.resolution?.ok) return Promise.resolve(this.resolution);
    if (!this.verifying) {
      this.verifying = resolveCodexHostExecutable(this.hostParentPid, this.deps).then((resolution) => {
        this.resolution = resolution;
        this.verifying = undefined;
        this.log(resolution.ok
          ? { stage: "host_verified", version: resolution.executable.version }
          : { stage: "host_unavailable", reason: resolution.reason, ...(resolution.detail ? { detail: redactString(resolution.detail) } : {}) });
        return resolution;
      });
    }
    return this.verifying;
  }

  private async trigger(threadId: string, stillPending: () => boolean): Promise<void> {
    this.inflight = true;
    try {
      const resolution = await this.verify();
      if (this.stopped || !resolution.ok) return;
      if ((this.deps.readParentPid ?? (() => process.ppid))() !== this.hostParentPid) {
        this.resolution = { ok: false, reason: "parent-changed" };
        return;
      }
      const execFile = this.deps.execFile ?? defaultExecFile;
      const outcome = await execFile(resolution.executable.path, ["queue", "--thread", threadId, "--message", CODEX_QUEUE_WAKE_TRIGGER], {
        timeout: QUEUE_TIMEOUT_MS,
        env: hostSubprocessEnv(this.deps.env),
      });
      this.handleOutcome(outcome, threadId, stillPending);
    } catch (error) {
      this.scheduleRetry(threadId, stillPending, errorMessage(error));
    } finally {
      this.inflight = false;
    }
  }

  private handleOutcome(outcome: ExecFileOutcome, threadId: string, stillPending: () => boolean): void {
    if (outcome.spawnError) {
      this.scheduleRetry(threadId, stillPending, outcome.spawnError);
      return;
    }
    if (outcome.code === 0) {
      this.outstanding = true;
      this.attempts = 0;
      this.lastError = undefined;
      this.triggers += 1;
      this.lastTriggerAt = new Date(this.now()).toISOString();
      this.log({ stage: "trigger_queued" });
      return;
    }
    const detail = redactString(outcome.stderr.trim().slice(0, STDERR_DETAIL_LIMIT));
    if (outcome.ambiguous) {
      this.degraded = true;
      this.outstanding = true;
      this.lastError = `codex queue outcome unknown (${outcome.signal ?? "no exit status"})${detail ? `: ${detail}` : ""}`;
      this.log({ stage: "trigger_ambiguous", signal: outcome.signal });
      return;
    }
    const reason = classifyQueueFailure(outcome.stderr);
    const message = `codex queue exited ${outcome.code}${detail ? `: ${detail}` : ""}`;
    if (reason) {
      this.stopReason = reason;
      this.lastError = message;
      this.log({ stage: "trigger_rejected", reason, code: outcome.code });
      return;
    }
    this.scheduleRetry(threadId, stillPending, message);
  }

  private scheduleRetry(threadId: string, stillPending: () => boolean, error: string): void {
    this.attempts += 1;
    this.lastError = error;
    if (this.stopped) return;
    if (this.attempts >= MAX_QUEUE_ATTEMPTS) {
      this.stopReason = "queue-failed";
      this.log({ stage: "trigger_failed", reason: "queue-failed", attempts: this.attempts });
      return;
    }
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempts - 1), BACKOFF_CAP_MS);
    const jitter = base * 0.25 * (2 * (this.deps.random ?? Math.random)() - 1);
    const delay = Math.max(1, Math.round(base + jitter));
    this.nextRetryAt = this.now() + delay;
    this.log({ stage: "trigger_retry", attempt: this.attempts, delayMs: delay });
    const setTimer = this.deps.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.retryTimer = setTimer(() => {
      this.retryTimer = undefined;
      this.nextRetryAt = undefined;
      if (this.stopped || !stillPending()) return;
      void this.trigger(threadId, stillPending);
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.retryTimer);
    this.retryTimer = undefined;
    this.nextRetryAt = undefined;
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
