import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tempPath, 0o600); } catch { /* best-effort on non-POSIX filesystems */ }
  try {
    renameSync(tempPath, path);
    return true;
  } catch {
    return false;
  }
}
