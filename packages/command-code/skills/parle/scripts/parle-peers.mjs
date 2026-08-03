#!/usr/bin/env node
// Operator-only stable peer-context editor (issue #53).
//
// Mutation of retained peer routes must prove operator provenance. MCP hosts
// have no operator-typed command surface, so this helper is the mutation
// path: it refuses to run without an interactive terminal, which keeps hook
// processes, piped automation, and model-initiated shells out. Reads are
// available to models through parle_status; writes only through here or a
// host-native operator command (Pi's /parle-peers).
//
// Usage:
//   parle-peers.mjs list
//   parle-peers.mjs add <label> <@address> [role...]
//   parle-peers.mjs remove <label>
//   parle-peers.mjs clear
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_PEERS = 64;
const PEER_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PEER_ADDRESS_RE = /^@[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function catalogPath() {
  if (process.env.PARLE_PROFILES_PATH) return process.env.PARLE_PROFILES_PATH;
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
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return (Array.isArray(parsed?.peers) ? parsed.peers : []).slice(0, MAX_PEERS)
      .filter((peer) => typeof peer?.label === "string" && typeof peer?.address === "string");
  } catch {
    return [];
  }
}

function writePeers(peers) {
  const path = peersPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path) && !ownerOnly(path)) {
    throw new Error(`Refusing to write ${path}: it is not an owner-only regular file.`);
  }
  const tmp = join(dir, `.peers.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, peers }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
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

if (action !== "list" && !process.stdin.isTTY) {
  fail("parle-peers mutations require an interactive terminal: stable peer routes are operator facts, and this helper refuses piped, hook, or automated invocation. Run it yourself in a terminal.");
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
  if (!address || !PEER_ADDRESS_RE.test(address)) fail("Peer address must be a full @principal.agent or @principal.agent.route address.");
  const peers = readPeers().filter((peer) => peer.label !== label);
  if (peers.length >= MAX_PEERS) fail(`Peer context is capped at ${MAX_PEERS} entries. Remove one first.`);
  const role = roleParts.join(" ").trim();
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
  writePeers(next);
  console.log(`Removed stable peer ${label}.`);
  process.exit(0);
}

writePeers([]);
console.log("Cleared all stable peer routes.");
