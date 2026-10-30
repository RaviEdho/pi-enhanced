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
