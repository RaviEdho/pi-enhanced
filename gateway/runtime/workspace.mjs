import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function readOptionalJson(path) {
  try {
    if (statSync(path).size > 32 * 1024) throw new Error("Workspace metadata is too large");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function validateWorkspaceDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Workspace must be an absolute directory");
  const cwd = realpathSync(path);
  if (!statSync(cwd).isDirectory()) throw new Error("Workspace is not a directory");
  accessSync(cwd, constants.R_OK | constants.X_OK);
  return cwd;
}

export function validateConversationFile(path, directory) {
  if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) throw new Error("Invalid conversation file");
  const file = realpathSync(path);
  if (dirname(file) !== realpathSync(directory) || !statSync(file).isFile()) {
    throw new Error("Conversation file is outside this Discord session");
  }
  return file;
}

/** A conversation file from another gateway session, used as a forking source. */
export function validateForkSource(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) throw new Error("Invalid fork source");
  const file = realpathSync(path);
  const size = statSync(file).size;
  if (!statSync(file).isFile() || size > 64 * 1024 * 1024) throw new Error("Fork source is unavailable");
  return file;
}

/** Fork a conversation into a new file whose header points at a different cwd. */
export function forkConversationForWorkspace(sourceFile, targetCwd, directory) {
  const source = validateConversationFile(sourceFile, directory);
  if (statSync(source).size > 64 * 1024 * 1024) throw new Error("Conversation is too large to fork");
  const lines = readFileSync(source, "utf8").split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("Conversation is empty");
  let header;
  try { header = JSON.parse(lines[0]); } catch { throw new Error("Conversation header is invalid"); }
  if (header?.type !== "session") throw new Error("Conversation header is invalid");
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const file = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const body = lines.slice(1).map((line) => `${line}\n`).join("");
  // Match Pi's SessionManager.forkFrom: the fork always uses the current format.
  writeFileSync(file, `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd: targetCwd,
    parentSession: source,
  })}\n${body}`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { file, id };
}

/** Keep workspace/model/thinking, but no conversation, when rotating a gateway session. */
export function createFreshConversation(sourceFile, sourceDirectory, targetDirectory, cwd) {
  const source = validateConversationFile(sourceFile, sourceDirectory);
  if (statSync(source).size > 64 * 1024 * 1024) throw new Error("Conversation is too large to inspect");
  validateWorkspaceDirectory(cwd);
  const records = readFileSync(source, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (records[0]?.type !== "session") throw new Error("Conversation header is invalid");
  const entries = records.slice(1).filter((entry) => typeof entry.id === "string");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let entry = entries.at(-1);
  let model;
  let thinking;
  const visited = new Set();
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    if (!model && entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    if (!thinking && entry.type === "thinking_level_change") thinking = { thinkingLevel: entry.thinkingLevel };
    entry = byId.get(entry.parentId);
  }
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const file = join(targetDirectory, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const fresh = [{ type: "session", version: 3, id, timestamp, cwd }];
  let parentId = null;
  for (const [type, selection] of [["model_change", model], ["thinking_level_change", thinking]]) {
    if (!selection) continue;
    const entryId = randomUUID();
    fresh.push({ type, id: entryId, parentId, timestamp, ...selection });
    parentId = entryId;
  }
  writeFileSync(file, `${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  saveWorkspace(targetDirectory, {
    cwd, sessionFile: file,
    rolloverSelection: model || thinking ? {
      model: model && { provider: model.provider, id: model.modelId },
      thinkingLevel: thinking?.thinkingLevel,
    } : undefined,
  });
  return file;
}

export function loadWorkspace(directory) {
  const state = readOptionalJson(join(directory, "workspace.json"));
  if (!state) return undefined;
  validateWorkspaceDirectory(state.cwd);
  return {
    // Keep the spelling recorded by Pi's session header (including legacy
    // symlink paths); --session restores that exact cwd.
    cwd: state.cwd,
    sessionFile: validateConversationFile(state.sessionFile, directory),
    appliedRequestId: state.appliedRequestId,
    ...(state.rolloverSelection ? { rolloverSelection: state.rolloverSelection } : {}),
  };
}

export function loadWorkspaceRequest(directory, { validateTarget = true } = {}) {
  const request = readOptionalJson(join(directory, "cwd-request.json"));
  if (!request) return undefined;
  if (request.type !== "set_working_directory" || typeof request.requestId !== "string" || typeof request.token !== "string" || typeof request.previousCwd !== "string") {
    throw new Error("Invalid workspace switch request");
  }
  if (typeof request.cwd !== "string" || !isAbsolute(request.cwd)) throw new Error("Invalid requested workspace");
  return {
    ...request,
    cwd: validateTarget ? validateWorkspaceDirectory(request.cwd) : request.cwd,
    sessionFile: validateConversationFile(request.sessionFile, directory),
  };
}

export function saveWorkspace(directory, state) {
  const path = join(directory, "workspace.json");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

export function clearWorkspaceRequest(directory) {
  try { unlinkSync(resolve(directory, "cwd-request.json")); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
