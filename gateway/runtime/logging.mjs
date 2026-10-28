export function summarizeDiscordError(error) {
  const code = error && typeof error === "object" ? error.code || error.status : undefined;
  if (String(code) === "4014") return "Discord rejected a privileged Gateway Intent; enable Message Content Intent in the Developer Portal.";
  if (code) return `Discord error (code ${String(code).slice(0, 30)}). Check the bot token, intents, and permissions.`;
  return "Discord connection failed. Check the bot token, intents, and network connection.";
}

export function safeErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}

export function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}
