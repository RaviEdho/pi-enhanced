import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const bumps = [
  { kind: "patch", label: "Patch", part: 2 },
  { kind: "minor", label: "Minor", part: 1 },
  { kind: "major", label: "Major", part: 0 },
] as const;

export type ReleaseBump = (typeof bumps)[number]["kind"];
type BumpChoice = (typeof bumps)[number];

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

function parseVersion(value: unknown) {
  if (typeof value !== "string" || value.length > 256) return undefined;
  const match = semver.exec(value);
  if (!match || match[4]?.split(".").some(identifier => /^0\d+$/.test(identifier))) return undefined;
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) return undefined;
  return { value, numbers, prerelease: !!match[4] };
}

function incrementVersion(current: NonNullable<ReturnType<typeof parseVersion>>, part: BumpChoice["part"]): string | undefined {
  // npm promotes a prerelease to the same version if no lower component needs resetting.
  const increment = !current.prerelease || current.numbers.slice(part + 1).some(value => value !== 0);
  const next = current.numbers.map((value, index) => index === part ? value + Number(increment) : index > part ? 0 : value);
  return next.every(Number.isSafeInteger) ? next.join(".") : undefined;
}

export function isReleaseBump(value: string): value is ReleaseBump {
  return bumps.some(({ kind }) => kind === value);
}

export function nextReleaseVersion(current: string, bump: ReleaseBump): string | undefined {
  const version = parseVersion(current);
  const choice = bumps.find(({ kind }) => kind === bump);
  return version && choice ? incrementVersion(version, choice.part) : undefined;
}

export async function selectReleaseVersion<Extra extends string>(
  ui: Pick<ExtensionCommandContext["ui"], "select">,
  current: unknown,
  extra: Extra,
  acceptsVersion?: (version: string) => boolean,
): Promise<ReleaseBump | Extra | undefined> {
  const version = parseVersion(current);
  const choices = bumps.flatMap(({ kind, label, part }) => {
    const next = version && incrementVersion(version, part);
    if (acceptsVersion && (!next || !acceptsVersion(next))) return [];
    return [{ kind, label: next ? `${label} → ${next}` : label }];
  });
  const title = version ? `Release version (current: ${version.value})` : "Release version";
  const selected = await ui.select(title, [...choices.map(({ label }) => label), extra]);
  return selected === extra ? extra : choices.find(({ label }) => label === selected)?.kind;
}
