// Tool arguments are untrusted and can contain credentials. Only render a small,
// conservative subset of path/pattern values; never render arbitrary arguments.
function safeDetail(value) {
  if (typeof value !== "string" || !value || value.length > 160 || !/^[\w./*?{}!,+@ -]+$/.test(value)) return undefined;
  if (/(?:^|[/. _-])(?:env|secret|secrets|token|tokens|password|passwd|credential|credentials|apikey|api[-_]?key|private)(?:$|[/. _-])/i.test(value)) return undefined;
  if (/[A-Za-z0-9]{32,}/.test(value)) return undefined;
  return value;
}

export function codeDetail(value) {
  const safe = safeDetail(value);
  return safe ? `\`${safe}\`` : undefined;
}

export function workspaceDetail(value) {
  // Workspace paths were already disclosed by the existing completion notice.
  // Render as code without allowing line breaks or Markdown injection.
  if (typeof value !== "string") return "(unknown)";
  return `\`${value.replace(/[\x00-\x1f\x7f`]/g, "?").slice(0, 300)}\``;
}

export function toolActivity(toolName, args = {}, channelName) {
  const path = codeDetail(args?.path);
  switch (toolName) {
    case "set_working_directory": return undefined; // A completion notice is sent after the handoff.
    case "read": return path ? `Reading ${path}` : "Reading a file";
    case "edit": return path ? `Editing ${path}` : "Editing a file";
    case "write": return path ? `Writing ${path}` : "Writing a file";
    case "find": {
      const pattern = codeDetail(args?.pattern);
      return pattern ? `Finding files matching ${pattern}` : "Finding files";
    }
    case "grep": return "Searching project contents";
    case "bash": return "Running a shell command";
    case "web_search": return "Searching the web";
    case "web_fetch": return "Fetching a web page";
    case "ask_user": return "Asking for input";
    case "discord_gateway_restart": return "Requesting gateway restart";
    case "discord_list_channels": return "Reading channel list";
    case "discord_channel_history": return channelName ? `Reading #${channelName}’s message history` : "Reading channel message history";
    case "subagent": return "Delegating a task";
    case "subagent_status": return "Checking a delegated task";
    case "subagent_list": return "Listing delegated tasks";
    case "subagent_cancel": return "Cancelling a delegated task";
    default: return typeof toolName === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(toolName) ? `Using tool: ${toolName}` : "Using a tool";
  }
}

export function safeChannelName(value) {
  return typeof value === "string" && /^[\p{L}\p{N}_-]{1,100}$/u.test(value) ? value : undefined;
}
