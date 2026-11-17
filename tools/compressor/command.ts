/** Conservative dispatch only: never treat arguments or shell source as commands. */
export function getFilterCommand(source: string): string | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) { quote = ""; continue; }
      // Substitutions and PowerShell escapes are deliberately not interpreted.
      if (quote === '"' && /[$`\\]/.test(ch)) return;
      word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r") return;
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      if (/[;&|<>(){}$`\\#]/.test(ch)) return;
      word += ch;
      started = true;
    }
  }
  if (quote) return;
  if (started) words.push(word);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  if (words[0] === "env") {
    words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  }
  if (words[0] === "command") words.shift();
  let executable = (words.shift() ?? "").split("/").pop()!;
  if (executable === "npx" || executable === "bunx") {
    if (words[0] === "--yes" || words[0] === "-y") words.shift();
    executable = words.shift() ?? "";
  } else if (["npm", "pnpm", "yarn", "bun"].includes(executable) && ["exec", "x"].includes(words[0])) {
    words.shift();
    if (words[0] === "--") words.shift();
    executable = words.shift() ?? "";
  } else if (executable === "uv" && words[0] === "run") {
    words.shift();
    executable = words.shift() ?? "";
  }
  if (/^python(?:3(?:\.\d+)?)?$/.test(executable) && words[0] === "-m") {
    words.shift();
    executable = words.shift() ?? "";
  }
  // The canonical command contains only safe tokens. Quoted prose cannot inject
  // parser keywords, and unknown wrappers/subcommands simply pass through.
  const supported = new Set([
    "git", "cargo", "go", "vitest", "jest", "pytest", "npm", "pnpm", "yarn", "bun", "deno",
    "rake", "rspec", "tsc", "eslint", "biome", "ruff", "oxlint", "rubocop", "golangci-lint",
    "markdownlint", "yamllint", "hadolint", "sqlfluff", "pip", "pip3", "poetry", "uv", "brew",
    "terraform", "tofu", "pre-commit", "df", "curl", "wget", "ls", "tree", "find", "docker", "podman",
  ]);
  if (!supported.has(executable) || words.some((w) => /^(?:--help|-h|--version)$/.test(w))) return;
  if (executable === "pip3") executable = "pip";
  if (executable === "git") {
    while (words[0]?.startsWith("-")) {
      const flag = words.shift()!;
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(flag)) {
        if (words.shift() === undefined) return;
      } else if (!/^(?:--(?:git-dir|work-tree|namespace)=|--(?:no-pager|literal-pathspecs)$)/.test(flag)) return;
    }
    // Machine-readable/alternate formats must not enter human-output parsers.
    if (words.some((w) => /^(?:--(?:word-diff|porcelain|format|pretty|name-only|name-status|numstat|raw|shortstat)|-z|-s|--short)(?:=|$)/.test(w))) return;
  }
  if (executable === "ruff" && words[0] !== "check") return;
  if (["docker", "podman"].includes(executable) && words.some((w) => /^(?:--format|--quiet|-q)(?:=|$)/.test(w))) return;
  // Only the executable and subcommand are eligible to match dispatch regexes.
  // Remaining arguments are opaque, preventing e.g. `npm run jest-helper` or
  // `git log --grep='git status'` from selecting a different parser.
  const subcommand = words.shift();
  return [executable, /^[A-Za-z][A-Za-z0-9-]*$/.test(subcommand ?? "") ? subcommand : ""].filter(Boolean).join(" ");
}
