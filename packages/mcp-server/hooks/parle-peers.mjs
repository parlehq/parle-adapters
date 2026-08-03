#!/usr/bin/env node
// Operator-only stable peer-context editor (issue #53).
//
// This helper is the mutation path for MCP hosts. Its interactivity gate
// (stdin TTY plus a confirmation typed on the controlling terminal) excludes
// hook processes, pipes, and casual automation; it is deliberate friction,
// not proof of human origin. A host that grants an agent unrestricted shell
// access can allocate a PTY, so for such hosts the enforceable boundary is
// the host's own shell permissioning - the structural guarantees this design
// does make are that no model-callable tool mutates the store and no peer
// content is ever parsed for identities. Reads are available to models
// through parle_status; writes only through here or a host-native operator
// command (Pi's /parle-peers).
//
// Usage:
//   parle-peers.mjs list
//   parle-peers.mjs add <label> <@address> [role...]
//   parle-peers.mjs remove <label>
//   parle-peers.mjs clear
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_PEERS = 64;
const MAX_FIELD = 200;
const MAX_STORE_BYTES = 64 * 1024;
const PEER_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADDRESS_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const PEER_ADDRESS_RE = new RegExp(`^@${ADDRESS_LABEL}\\.${ADDRESS_LABEL}(?:\\.${ADDRESS_LABEL})?$`);

function dotEnvValue(cwd, key) {
  try {
    const text = readFileSync(join(cwd, ".env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0 || line.slice(0, eq).trim() !== key) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return value;
    }
  } catch {}
  return undefined;
}

// Canonical resolution mirrors the shared client: process env, then the
// project .env, relative values against cwd. The helper must always edit the
// same store every renderer reads.
function catalogPath() {
  const override = process.env.PARLE_PROFILES_PATH || dotEnvValue(process.cwd(), "PARLE_PROFILES_PATH");
  if (override) return isAbsolute(override) ? override : join(process.cwd(), override);
  return join(process.env.HOME || process.env.USERPROFILE || homedir(), ".parle", "profiles");
}

function peersPath() {
  return join(dirname(catalogPath()), "peers");
}

function ownerOnly(path) {
  const link = lstatSync(path);
  const stat = link.isSymbolicLink() ? statSync(path) : link;
  if (!stat.isFile()) return false;
  if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) return false;
  return true;
}

function readPeers() {
  const path = peersPath();
  try {
    if (!existsSync(path) || !ownerOnly(path)) return [];
    const link = lstatSync(path);
    if ((link.isSymbolicLink() ? statSync(path) : link).size > MAX_STORE_BYTES) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return (Array.isArray(parsed?.peers) ? parsed.peers : []).slice(0, MAX_PEERS)
      .map((peer) => ({
        label: typeof peer?.label === "string" ? peer.label.slice(0, MAX_FIELD) : "",
        address: typeof peer?.address === "string" ? peer.address.slice(0, MAX_FIELD) : "",
        ...(typeof peer?.role === "string" && peer.role ? { role: peer.role.slice(0, MAX_FIELD) } : {}),
        ...(typeof peer?.taggedAt === "string" ? { taggedAt: peer.taggedAt.slice(0, 40) } : {}),
      }))
      .filter((peer) => peer.label && peer.address);
  } catch {
    return [];
  }
}

function writePeers(peers) {
  const path = peersPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`Refusing to write: ${dir} is not a regular directory.`);
  if (process.platform !== "win32" && dirStat.uid !== process.getuid?.()) throw new Error(`Refusing to write: ${dir} is not owned by the current user.`);
  chmodSync(dir, 0o700);
  let writePath = path;
  if (existsSync(path)) {
    if (!ownerOnly(path)) throw new Error(`Refusing to write ${path}: it is not an owner-only regular file.`);
    writePath = lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  }
  const tmp = join(dir, `.peers.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, peers }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, writePath);
    chmodSync(writePath, 0o600);
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw error;
  }
}

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const [action, ...rest] = process.argv.slice(2);

if (!action || !["list", "add", "remove", "clear"].includes(action)) {
  fail("usage: parle-peers.mjs list | add <label> <@address> [role...] | remove <label> | clear");
}

// The interactivity gate raises the bar against hooks, pipes, and casual
// automation; it is deliberate friction, not proof of human origin. A host
// that grants an agent unrestricted shell access can allocate a PTY, so the
// real boundary for such hosts is their own shell permissioning. The
// confirmation below must be typed on the controlling terminal (/dev/tty),
// which does not exist for processes started without one.
function confirmOnControllingTerminal(expected) {
  let fd;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    fail("parle-peers mutations require a controlling terminal: stable peer routes are operator facts, and this helper refuses hook, piped, or automated invocation. Run it yourself in a terminal.");
  }
  try {
    process.stderr.write(`Type the peer label (${expected}) to confirm: `);
    const buffer = Buffer.alloc(256);
    const bytes = readSync(fd, buffer, 0, buffer.length);
    const typed = buffer.subarray(0, bytes).toString("utf8").trim();
    if (typed !== expected) fail("Confirmation did not match; nothing changed.");
  } finally {
    closeSync(fd);
  }
}

if (action !== "list" && !process.stdin.isTTY) {
  fail("parle-peers mutations require an interactive terminal: stable peer routes are operator facts, and this helper refuses hook, piped, or automated invocation. Run it yourself in a terminal.");
}

if (action === "list") {
  const peers = readPeers();
  if (peers.length === 0) {
    console.log("No stable peer routes are tagged.");
  } else {
    for (const peer of peers) console.log(`${peer.label}\t${peer.address}${peer.role ? `\t${peer.role}` : ""}${peer.taggedAt ? `\t(tagged ${peer.taggedAt})` : ""}`);
  }
  process.exit(0);
}

if (action === "add") {
  const [label, address, ...roleParts] = rest;
  if (!label || !PEER_LABEL_RE.test(label)) fail("Peer label must be 1-64 characters of letters, numbers, dot, underscore, or hyphen, starting with a letter or number.");
  if (!address || address.length > MAX_FIELD || !PEER_ADDRESS_RE.test(address)) fail("Peer address must be a full @principal.agent or @principal.agent.route address.");
  const peers = readPeers().filter((peer) => peer.label !== label);
  if (peers.length >= MAX_PEERS) fail(`Peer context is capped at ${MAX_PEERS} entries. Remove one first.`);
  const role = roleParts.join(" ").trim().slice(0, MAX_FIELD);
  confirmOnControllingTerminal(label);
  peers.push({ label, address, ...(role ? { role } : {}), taggedAt: new Date().toISOString() });
  writePeers(peers);
  console.log(`Tagged stable peer ${label} -> ${address}${role ? ` (${role})` : ""}`);
  process.exit(0);
}

if (action === "remove") {
  const [label] = rest;
  const peers = readPeers();
  const next = peers.filter((peer) => peer.label !== label);
  if (next.length === peers.length) fail(`No stable peer is tagged as ${label}.`);
  confirmOnControllingTerminal(label);
  writePeers(next);
  console.log(`Removed stable peer ${label}.`);
  process.exit(0);
}

confirmOnControllingTerminal("clear");
writePeers([]);
console.log("Cleared all stable peer routes.");
