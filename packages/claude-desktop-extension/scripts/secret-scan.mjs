import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const roots = process.argv.slice(2).map((root) => resolve(root));
if (roots.length === 0) roots.push(resolve("."));

const denyPathSegments = new Set([".env", ".parle", ".galexc", ".claude", ".pi", ".agents", ".git", "node_modules"]);
const secretPatterns = [
  /parle_agt_[A-Za-z0-9_./+=:-]+/g,
  /parle_inv_[A-Za-z0-9_./+=:-]+/g,
  /prt_[A-Za-z0-9_./+=:-]+/g,
  /__Host-parle_session=[^;\s]+/g,
  /Bearer\s+[A-Za-z0-9_./+=:-]+/g,
];
const allowedLiterals = new Set([
  "PARLE_ROOM_AGENT_TOKEN",
  "PARLE_AGENT_TOKEN_ID",
  "parle_agent_token",
]);

const findings = [];
for (const root of roots) scanPath(root);
if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  throw new Error(`Secret scan failed with ${findings.length} finding(s)`);
}

function scanPath(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const parts = path.split(/[\\/]/);
    if (parts.some((part) => denyPathSegments.has(part))) return;
    for (const entry of readdirSync(path)) scanPath(resolve(path, entry));
    return;
  }
  if (!stat.isFile()) return;
  if (stat.size > 2 * 1024 * 1024) return;
  const text = readFileSync(path, "utf8");
  for (const pattern of secretPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (isAllowedMatch(match[0])) continue;
      findings.push(`${path}: possible secret ${redact(match[0])}`);
    }
  }
}

function isAllowedMatch(value) {
  if (allowedLiterals.has(value)) return true;
  // Skip regex-source self matches. This assumes current Parle token alphabets do not include these characters.
  if (value.includes(")") || value.includes("[") || value.includes("\\")) return true;
  return false;
}

function redact(value) {
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 6)}...<redacted>`;
}
