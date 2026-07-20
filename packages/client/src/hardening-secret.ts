#!/usr/bin/env node
import qrcode from "qrcode-terminal";
import { ParleHardeningClient } from "./hardening.js";

const COMMANDS = new Set(["password", "bootstrap-proof", "totp-code", "show-provisioning-qr", "ack-recovery-stored"]);
const RECORDING_ENV = ["ASCIINEMA_REC", "ASCIINEMA_CONFIG_HOME", "SCRIPT", "SCRIPT_COMMAND", "TMUX", "STY", "ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID", "TERMINAL_RECORDING", "RECORDING"];
const SECRET_ENV = /(?:PASSWORD|SECRET|TOTP|OTP|RECOVERY|PROOF)/i;

function rejectUnsafeInvocation(): string {
  if (process.argv.length !== 3 || !COMMANDS.has(process.argv[2] || "")) throw new Error("parle-hardening-secret accepts exactly one non-secret command.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("parle-hardening-secret requires a controlling TTY and refuses redirected input.");
  for (const key of RECORDING_ENV) if (process.env[key]) throw new Error("parle-hardening-secret refuses detectable terminal recording or multiplexer environments. Detection is best-effort, not a security proof.");
  for (const [key, value] of Object.entries(process.env)) {
    if (value && (key === "PARLE_SESSION_COOKIE" || key.startsWith("PARLE_HARDENING_") || SECRET_ENV.test(key))) {
      throw new Error("parle-hardening-secret refuses secret-bearing environment input.");
    }
  }
  return process.argv[2]!;
}

function prompt(question: string, secret: boolean): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.reject(new Error("parle-hardening-secret requires a controlling TTY."));
  process.stdout.write(question);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    const chars: Buffer[] = [];
    const done = (error?: Error) => {
      input.off("data", onData);
      try { input.setRawMode(false); } catch {}
      input.pause();
      if (error) reject(error);
      else resolve(Buffer.concat(chars).toString("utf8"));
      for (const chunk of chars) chunk.fill(0);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return done(new Error("Interactive hardening input cancelled."));
        if (byte === 13 || byte === 10) {
          process.stdout.write("\n");
          return done();
        }
        if (byte === 127 || byte === 8) {
          if (chars.length > 0) {
            const prior = chars.pop();
            prior?.fill(0);
            if (!secret) process.stdout.write("\b \b");
          }
          continue;
        }
        if (chars.length >= 8192) return done(new Error("Interactive hardening input exceeds its bounded size."));
        const value = Buffer.from([byte]);
        chars.push(value);
        if (!secret) process.stdout.write(value);
      }
    };
    input.on("data", onData);
  });
}

async function hidden(question: string): Promise<Buffer> {
  const value = await prompt(question, true);
  const buffer = Buffer.from(value, "utf8");
  return buffer;
}

async function password(client: ParleHardeningClient): Promise<void> {
  const mode = (await prompt("Type set for a new password or change to replace one (input hidden; do not enter the password yet): ", true)).trim().toLowerCase();
  if (mode !== "set" && mode !== "change") throw new Error("Password mode must be set or change.");
  const next = await hidden("New password: ");
  const repeat = await hidden("Repeat new password: ");
  try {
    if (!next.equals(repeat)) throw new Error("Passwords did not match. Nothing was staged.");
    if (mode === "change") {
      const current = await hidden("Current password: ");
      await client.stagePassword("change", next, current);
    } else {
      await client.stagePassword("set", next);
    }
  } finally {
    next.fill(0);
    repeat.fill(0);
  }
  process.stdout.write("Protected password input staged. Return to the orchestration tool.\n");
}

async function bootstrapProof(client: ParleHardeningClient): Promise<void> {
  const proof = await hidden("Current password: ");
  try { await client.stageBootstrapProof(proof); } finally { proof.fill(0); }
  process.stdout.write("Protected bootstrap proof staged. Return to the orchestration tool.\n");
}

async function totpCode(client: ParleHardeningClient): Promise<void> {
  const code = await hidden("Current six-digit authenticator code: ");
  try { await client.stageTotpCode(code); } finally { code.fill(0); }
  process.stdout.write("Protected authenticator code staged. Return to the orchestration tool.\n");
}

async function showProvisioningQr(client: ParleHardeningClient): Promise<void> {
  const uri = client.readProvisioningUriForTty();
  try {
    qrcode.generate(uri.toString("utf8"), { small: true }, (rendered: string) => process.stdout.write(rendered));
    await prompt("Scan this QR with the human authenticator, then press Enter to clear it: ", false);
  } finally {
    uri.fill(0);
    process.stdout.write("\x1b[2J\x1b[H");
  }
  process.stdout.write("Provisioning QR display cleared. Return to the orchestration tool.\n");
}

async function acknowledgeRecoveryStored(client: ParleHardeningClient): Promise<void> {
  const answer = await prompt("Type RECOVERY CODES STORED after moving the batch to protected storage: ", false);
  if (answer !== "RECOVERY CODES STORED") throw new Error("Recovery storage acknowledgement was not accepted.");
  await client.acknowledgeRecoveryStored();
  process.stdout.write("Recovery storage acknowledgement recorded. Return to the orchestration tool.\n");
}

async function main(): Promise<void> {
  const command = rejectUnsafeInvocation();
  const client = new ParleHardeningClient();
  if (command === "password") return password(client);
  if (command === "bootstrap-proof") return bootstrapProof(client);
  if (command === "totp-code") return totpCode(client);
  if (command === "show-provisioning-qr") return showProvisioningQr(client);
  return acknowledgeRecoveryStored(client);
}

main().catch(() => {
  // Error detail must never inherit a secret-bearing terminal value, server
  // response, or filesystem path. The nonzero exit is the caller signal.
  process.stderr.write("parle-hardening-secret could not complete safely.\n");
  process.exitCode = 2;
});
