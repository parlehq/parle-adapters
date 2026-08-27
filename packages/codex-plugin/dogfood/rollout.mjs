// Codex rollout JSONL helpers for the real-Codex dogfood. Zero dependencies.
//
// parseRollout reads the rollout shapes the dogfood judges: `response_item`
// lines whose payload is a function_call, custom_tool_call (Codex code mode,
// where tool calls are `tools.<name>({...})` expressions inside a JS `exec`
// input), their outputs, and role messages. evaluateDiagnostics turns the
// parsed transcript into pass/fail rows for the `diagnostic` checks in
// scenarios.json. Authoritative checks are parle's job, not this file's.

const HOOK_DELIVERY_MARKER = "Parle responsive delivery seq=";
const STATUS_TOOL_NAMES = new Set(["mcp__parle__parle_status", "parle_status"]);
const SHELL_TOOL_NAMES = new Set(["shell", "exec_command", "local_shell", "container.exec", "shell_command"]);
// A loop or sleep counts only in command position: at the start of the
// command or after a separator / `do` / `then`. `git log --until ...` is an
// argument, not a construct.
const POLLING_SHAPE = /(?:^|[;&|(\n]\s*|\b(?:do|then)\s+)(?:while|until|for\s+\S+\s+in|sleep\s+\d|watch)\b/;
// The same command must also talk to Parle: an HTTP client aimed at a parle
// host or a /v/ path, a parle URL, or an inbox/read tool invoked from shell.
const POLLING_TARGET = /\b(?:curl|wget|http)\b[^;&|\n]*(?:parle|\/v\/)|https?:\/\/[^\s"']*parle|\bparle_(?:inbox|read)\b/i;

function parseJsonLoose(text) {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// JS object literals in code-mode calls are not JSON: unquoted keys, single
// quotes, trailing commas. Normalize the common cases; anything stranger is
// kept verbatim under `_raw` so the call is still counted.
function parseObjectLiteral(text) {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  const direct = parseJsonLoose(trimmed);
  if (direct !== undefined) return direct;
  const normalized = trimmed
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, body) => JSON.stringify(body.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
  const relaxed = parseJsonLoose(normalized);
  return relaxed !== undefined ? relaxed : { _raw: trimmed };
}

function balancedArgument(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) return source.slice(start, index);
      depth -= 1;
    }
  }
  return source.slice(start);
}

export function extractCodeModeCalls(input) {
  const calls = [];
  const pattern = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    const argumentText = balancedArgument(input, match.index + match[0].length);
    calls.push({ name: match[1], args: parseObjectLiteral(argumentText) });
    pattern.lastIndex = match.index + match[0].length + argumentText.length;
  }
  return calls;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

function outputText(output) {
  const value = typeof output === "string" ? parseJsonLoose(output) ?? output : output;
  if (typeof value === "string") return value;
  if (value && Array.isArray(value.content)) return messageText(value.content);
  if (value && typeof value.output === "string") return value.output;
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function payloadOf(line) {
  if (line?.type === "response_item" && line.payload && typeof line.payload === "object") return line.payload;
  if (line?.payload && typeof line.payload === "object" && typeof line.payload.type === "string") return line.payload;
  if (typeof line?.type === "string") return line;
  return undefined;
}

export function parseRollout(input) {
  const lines = Array.isArray(input) ? input : String(input ?? "").split(/\r?\n/);
  const parsed = { toolCalls: [], toolResults: [], agentMessages: [], developerMessages: [], userMessages: [] };
  const namesByCallId = new Map();
  for (const raw of lines) {
    const line = typeof raw === "string" ? parseJsonLoose(raw) : raw;
    const item = payloadOf(line);
    if (!item) continue;
    const ts = typeof line?.timestamp === "string" ? line.timestamp : undefined;
    switch (item.type) {
      case "function_call": {
        const args = parseJsonLoose(item.arguments) ?? (item.arguments && typeof item.arguments === "object" ? item.arguments : {});
        parsed.toolCalls.push({ name: item.name, args, ts, callId: item.call_id });
        if (item.call_id) namesByCallId.set(item.call_id, [item.name]);
        break;
      }
      case "custom_tool_call": {
        const embedded = typeof item.input === "string" ? extractCodeModeCalls(item.input) : [];
        if (embedded.length === 0) parsed.toolCalls.push({ name: item.name, args: { input: item.input }, ts, callId: item.call_id });
        for (const call of embedded) parsed.toolCalls.push({ ...call, ts, callId: item.call_id, via: item.name });
        if (item.call_id) namesByCallId.set(item.call_id, embedded.length ? embedded.map((call) => call.name) : [item.name]);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const text = outputText(item.output);
        for (const name of namesByCallId.get(item.call_id) ?? ["unknown"]) parsed.toolResults.push({ name, text, ts });
        break;
      }
      case "message": {
        const text = messageText(item.content);
        if (item.role === "assistant") parsed.agentMessages.push(text);
        else if (item.role === "developer") parsed.developerMessages.push(text);
        else if (item.role === "user") parsed.userMessages.push(text);
        break;
      }
      default:
        break;
    }
  }
  return parsed;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
}

function argsMatchSubset(args, subset) {
  if (!subset) return true;
  if (!args || typeof args !== "object") return false;
  return Object.entries(subset).every(([key, value]) => deepEqual(args[key], value));
}

function forbiddenBy(args, predicates) {
  if (!predicates || !args || typeof args !== "object") return [];
  return Object.entries(predicates).filter(([key, predicate]) => {
    const value = args[key];
    if (typeof value !== "number") return false;
    if (predicate.gt !== undefined && value > predicate.gt) return true;
    return predicate.eq !== undefined && value === predicate.eq;
  }).map(([key]) => `${key}=${args[key]}`);
}

const SHELL_BINARY = /(?:^|\/)(?:ba|z|da)?sh$/;
const SHELL_SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/;
const SHELL_INVOCATION = /^\s*(\S+)\s+(-[a-z]*c[a-z]*)\s+([\s\S]+)$/;
const SHELL_UNWRAP_LIMIT = 4;

// The command string is the first shell word after -c, parsed the way a POSIX
// shell does: single-quoted segments (no escapes), double-quoted segments
// (backslash escapes), backslash-escaped characters, and bare characters
// concatenate until unquoted whitespace. Whatever follows is $0 and positional
// operands, never part of the script.
function commandStringToken(text) {
  const trimmed = text.trim();
  let out = "";
  let quote = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else out += char;
    } else if (quote === '"') {
      if (char === "\\" && index + 1 < trimmed.length) out += trimmed[++index];
      else if (char === '"') quote = null;
      else out += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "\\" && index + 1 < trimmed.length) out += trimmed[++index];
    else if (/\s/.test(char)) break;
    else out += char;
  }
  return out;
}

// Codex's shell tool wraps scripts as ["bash", "-lc", script], and a model can
// nest `bash -lc "..."` inside that again. The detector runs on the innermost
// script, taking only the command-string token at each level, bounded so a
// pathological command cannot recurse forever.
function innermostShellScript(command, depth = 0) {
  const match = depth < SHELL_UNWRAP_LIMIT ? command.match(SHELL_INVOCATION) : null;
  if (!match || !SHELL_BINARY.test(match[1]) || !SHELL_SCRIPT_FLAG.test(match[2])) return command;
  return innermostShellScript(commandStringToken(match[3]), depth + 1);
}

function shellCommandText(call) {
  if (!SHELL_TOOL_NAMES.has(call.name)) return undefined;
  const args = call.args || {};
  const command = args.command ?? args.cmd ?? args.input;
  if (Array.isArray(command)) {
    // Array form: the element after the flag is the script; later elements
    // are $0 and positional operands.
    const [shell, flag, script] = command;
    const wrapped = script !== undefined && SHELL_BINARY.test(String(shell)) && SHELL_SCRIPT_FLAG.test(String(flag));
    return innermostShellScript(wrapped ? String(script) : command.join(" "));
  }
  return typeof command === "string" ? innermostShellScript(command) : undefined;
}

function shellPollingOffenders(parsed) {
  const offenders = [];
  for (const call of parsed.toolCalls) {
    const command = shellCommandText(call);
    if (command && POLLING_SHAPE.test(command) && POLLING_TARGET.test(command)) offenders.push(command);
  }
  return offenders;
}

function missing(haystack, needles) {
  return (needles || []).filter((needle) => !haystack.includes(needle));
}

function present(haystack, needles) {
  return (needles || []).filter((needle) => haystack.includes(needle));
}

function evaluateToolCalls(parsed, check) {
  const matching = parsed.toolCalls.filter((call) => call.name === check.tool && argsMatchSubset(call.args, check.argsSubset));
  const count = matching.length;
  const min = check.min ?? 0;
  const forbidden = matching.flatMap((call) => forbiddenBy(call.args, check.argsForbid));
  const pass = count >= min && (check.max === undefined || count <= check.max) && forbidden.length === 0;
  const subset = check.argsSubset ? ` with args ⊇ ${JSON.stringify(check.argsSubset)}` : "";
  const bound = check.max === undefined ? `>= ${min}` : `in [${min}, ${check.max}]`;
  const forbid = forbidden.length ? `; forbidden args present: ${forbidden.join(", ")}` : "";
  return { pass, detail: `${count} call(s) to ${check.tool}${subset}; expected ${bound}${forbid}` };
}

function evaluateStatusText(parsed, check) {
  const texts = parsed.toolResults.filter((result) => STATUS_TOOL_NAMES.has(result.name)).map((result) => result.text);
  if (texts.length === 0) return { pass: false, detail: "no parle_status tool result in the rollout" };
  const text = texts.join("\n");
  const absent = missing(text, check.contains);
  const leaked = present(text, check.excludes);
  const pass = absent.length === 0 && leaked.length === 0;
  const detail = pass
    ? `status text carries ${JSON.stringify(check.contains || [])} and none of ${JSON.stringify(check.excludes || [])}`
    : [absent.length ? `missing ${JSON.stringify(absent)}` : "", leaked.length ? `contains excluded ${JSON.stringify(leaked)}` : ""].filter(Boolean).join("; ");
  return { pass, detail };
}

function evaluateAgentMessage(parsed, check) {
  const text = parsed.agentMessages.at(-1);
  if (text === undefined) return { pass: false, detail: "no assistant message in the rollout" };
  const absent = missing(text, check.contains);
  const anyHit = check.containsAny ? present(text, check.containsAny) : undefined;
  const pass = absent.length === 0 && (anyHit === undefined || anyHit.length > 0);
  const detail = pass
    ? `final assistant message matches${anyHit ? ` via ${JSON.stringify(anyHit)}` : ""}`
    : [absent.length ? `missing ${JSON.stringify(absent)}` : "", anyHit && anyHit.length === 0 ? `none of ${JSON.stringify(check.containsAny)} present` : ""].filter(Boolean).join("; ");
  return { pass, detail };
}

function evaluateHookDelivery(parsed) {
  const hits = [...parsed.developerMessages, ...parsed.userMessages].filter((text) => text.includes(HOOK_DELIVERY_MARKER));
  return { pass: hits.length > 0, detail: `${hits.length} hook-delivered message(s) carrying "${HOOK_DELIVERY_MARKER}"` };
}

export function evaluateDiagnostics(parsed, checks) {
  return (checks || []).map((check) => {
    let result;
    switch (check.kind) {
      case "tool-calls":
        result = evaluateToolCalls(parsed, check);
        break;
      case "no-shell-polling": {
        const offenders = shellPollingOffenders(parsed);
        result = { pass: offenders.length === 0, detail: offenders.length ? `polling shell command(s): ${offenders.join(" || ")}` : "no polling shell commands" };
        break;
      }
      case "status-text":
        result = evaluateStatusText(parsed, check);
        break;
      case "agent-message":
        result = evaluateAgentMessage(parsed, check);
        break;
      case "hook-delivery-present":
        result = evaluateHookDelivery(parsed);
        break;
      default:
        result = { pass: false, detail: `unknown diagnostic kind ${JSON.stringify(check.kind)}` };
    }
    return { kind: check.kind, ...result };
  });
}
