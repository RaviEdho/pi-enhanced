export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", "dist", "build", "target", ".next", ".turbo",
  ".cache", ".venv", "venv", "__pycache__", "coverage",
]);

export function isHiddenDirectory(name: string): boolean {
  return name.startsWith(".") && name !== ".github";
}
