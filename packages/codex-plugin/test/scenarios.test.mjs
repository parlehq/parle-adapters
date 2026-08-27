import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const repo = resolve(root, "../..");
const manifest = JSON.parse(readFileSync(resolve(root, "dogfood/scenarios.json"), "utf8"));
const schema = JSON.parse(readFileSync(resolve(root, "dogfood/scenarios.schema.json"), "utf8"));

// Minimal JSON Schema subset validator: enough for scenarios.schema.json
// without adding a validator dependency. Unsupported keywords are ignored, so
// keep the schema within: $ref, type, const, enum, required, properties,
// additionalProperties, items, minItems, minLength, minimum, pattern.
function validate(node, value, path, errors) {
  if (node.$ref) {
    const target = node.$ref.replace(/^#\//, "").split("/").reduce((acc, key) => acc?.[key], schema);
    assert.ok(target, `unresolved $ref ${node.$ref}`);
    return validate(target, value, path, errors);
  }
  const fail = (message) => errors.push(`${path}: ${message}`);
  if ("const" in node && JSON.stringify(value) !== JSON.stringify(node.const)) return fail(`expected const ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value)) return fail(`expected one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
  if (node.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("expected object");
    for (const key of node.required || []) if (!(key in value)) fail(`missing required ${key}`);
    for (const [key, child] of Object.entries(value)) {
      const childSchema = node.properties?.[key];
      if (childSchema) validate(childSchema, child, `${path}.${key}`, errors);
      else if (node.additionalProperties === false) fail(`unexpected property ${key}`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") validate(node.additionalProperties, child, `${path}.${key}`, errors);
    }
  } else if (node.type === "array") {
    if (!Array.isArray(value)) return fail("expected array");
    if (node.minItems !== undefined && value.length < node.minItems) fail(`expected at least ${node.minItems} items`);
    if (node.items) value.forEach((item, index) => validate(node.items, item, `${path}[${index}]`, errors));
  } else if (node.type === "string") {
    if (typeof value !== "string") return fail("expected string");
    if (node.minLength !== undefined && value.length < node.minLength) fail(`shorter than ${node.minLength}`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) fail(`does not match ${node.pattern}`);
  } else if (node.type === "integer") {
    if (!Number.isInteger(value)) return fail("expected integer");
    if (node.minimum !== undefined && value < node.minimum) fail(`below minimum ${node.minimum}`);
  }
}

function placeholdersIn(value) {
  return [...JSON.stringify(value).matchAll(/\{\{[^}]*\}\}/g)].map((match) => match[0]);
}

test("scenario manifest validates against its schema", () => {
  const errors = [];
  validate(schema, manifest, "$", errors);
  assert.deepEqual(errors, []);

  // The validator itself must reject a shape the schema forbids, or the
  // assertion above proves nothing.
  const broken = [];
  validate(schema, { ...manifest, scenarios: [{ ...manifest.scenarios[0], driver: "tmux", extra: 1 }] }, "$", broken);
  assert.deepEqual(broken, [
    '$.scenarios[0].driver: expected one of ["exec","app-server"], got "tmux"',
    "$.scenarios[0]: unexpected property extra",
  ]);
});

test("scenario manifest is consistent with the plugin, the MCP config, and the shared card format", () => {
  const plugin = JSON.parse(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(resolve(repo, ".agents/plugins/marketplace.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
  const toolRuntime = readFileSync(resolve(repo, "packages/mcp-server/src/tool-runtime.ts"), "utf8");
  const registeredTools = new Set([...toolRuntime.matchAll(/registerTool\("(parle_[a-z_]+)"/g)].map((match) => `mcp__parle__${match[1]}`));

  assert.equal(manifest.plugin.name, plugin.name);
  assert.equal(manifest.plugin.marketplace, marketplace.name);
  assert.deepEqual([...new Set(manifest.scenarios.map((scenario) => scenario.id))].length, manifest.scenarios.length);
  assert.deepEqual(manifest.scenarios.map((scenario) => scenario.id), schema.$defs.scenario.properties.id.enum);

  for (const scenario of manifest.scenarios) {
    for (const placeholder of placeholdersIn(scenario)) {
      assert.ok(manifest.placeholders.includes(placeholder), `${scenario.id} uses undeclared placeholder ${placeholder}`);
    }
    for (const name of Object.keys(scenario.env)) {
      assert.ok(mcp.mcpServers.parle.env_vars.includes(name), `${scenario.id} env ${name} would be dropped by Codex's cleared MCP environment`);
    }
    if (scenario.capMinutes !== undefined) assert.equal(scenario.id, "attended-hold");
    for (const check of scenario.diagnostic) {
      if (check.kind === "tool-calls") assert.ok(registeredTools.has(check.tool), `${scenario.id} names unregistered tool ${check.tool}`);
      if (check.kind === "agent-message") assert.ok(check.contains || check.containsAny, `${scenario.id} agent-message check has nothing to match`);
      if (check.kind === "status-text") assert.ok(check.contains || check.excludes, `${scenario.id} status-text check has nothing to match`);
    }
    for (const check of scenario.authoritative) {
      if (check.kind === "participant-identity" || check.kind === "no-authored-messages") assert.ok(check.agent, `${scenario.id} ${check.kind} needs agent`);
      if (check.kind === "authored-probe") assert.ok(check.bodyContains, `${scenario.id} authored-probe needs bodyContains`);
    }
  }

  const byId = Object.fromEntries(manifest.scenarios.map((scenario) => [scenario.id, scenario]));
  // Card label spacing is owned by packages/client/src/format.ts (padEnd 14).
  const actingAs = byId["profile-select"].diagnostic.find((check) => check.kind === "status-text").contains[0];
  assert.equal(actingAs, `${"Acting as".padEnd(14, " ")}@{{expected_agent_handle}}`);
  // Pinned wording for #170, #171, and #174: changing these in the runtime
  // means changing them here in the same commit.
  const hold = byId["attended-hold"].diagnostic.find((check) => check.kind === "tool-calls");
  assert.deepEqual(hold, { kind: "tool-calls", tool: "mcp__parle__parle_inbox", min: 2, argsSubset: { waitSeconds: 30 } });
  const wording = byId["status-wording"].diagnostic.find((check) => check.kind === "status-text");
  assert.deepEqual(wording, { kind: "status-text", contains: ["Delivery      watching (idle wake queue-only)"], excludes: ["arm or verify", "idle wake unarmed", "idle wake unavailable"] });
  assert.ok(manifest._note.includes(wording.contains[0]), "the pinned card line is listed in _note");
  assert.deepEqual(byId["attended-hold-control"].diagnostic[0].argsForbid, { waitSeconds: { gt: 0 } });
  assert.deepEqual(byId["identity-mismatch"].authoritative, [{ kind: "no-authored-messages", agent: "any" }]);
  assert.equal(byId["identity-mismatch"].catalog, "default-only");
  assert.deepEqual(byId["identity-mismatch"].env, { PARLE_PROFILE: "codex" });
  assert.equal(byId["idle-wake"].driver, "app-server");
});
