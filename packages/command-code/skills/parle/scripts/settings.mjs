const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];

function managedDefinition(command) {
  return { hooks: [{ type: "command", command, timeout: 5 }] };
}

function isManagedDefinition(value, command) {
  return value && typeof value === "object"
    && value.matcher === undefined
    && Array.isArray(value.hooks)
    && value.hooks.length === 1
    && value.hooks[0]?.type === "command"
    && value.hooks[0]?.command === command;
}

export function mergeParleHooks(settings, command) {
  const next = structuredClone(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {});
  if (next.hooks !== undefined && (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks))) {
    throw new Error("Command Code hooks must be an object");
  }
  next.hooks ||= {};
  for (const event of EVENTS) {
    const definitions = next.hooks[event];
    if (definitions !== undefined && !Array.isArray(definitions)) throw new Error(`Command Code hooks.${event} must be an array`);
    const list = definitions ? [...definitions] : [];
    const exact = list.filter((definition) => isManagedDefinition(definition, command));
    if (exact.length > 1) throw new Error(`Command Code ${event} contains duplicate managed Parle hooks`);
    if (exact.length === 0) list.push(managedDefinition(command));
    next.hooks[event] = list;
  }
  return next;
}

export function removeParleHooks(settings, command) {
  const next = structuredClone(settings && typeof settings === "object" ? settings : {});
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) return next;
  for (const event of EVENTS) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((definition) => !isManagedDefinition(definition, command));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}
