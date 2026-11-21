import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectGatewayOption } from "./select-dialog.js";

interface TimezoneChoice {
  id: string;
  city: string;
}

interface TimezoneOffsetGroup {
  offset: string;
  label: string;
  zones: TimezoneChoice[];
}

// Familiar cities keep the offset list short without limiting the actual city choices.
const exampleCities = new Set([
  "Amsterdam", "Athens", "Auckland", "Bangkok", "Berlin", "Buenos Aires",
  "Cairo", "Chicago", "Denver", "Dubai", "Halifax", "Hong Kong", "Honolulu", "Jakarta",
  "Karachi", "Kolkata", "London", "Los Angeles", "Mexico City", "Moscow", "New York",
  "Paris", "Perth", "Reykjavik", "Rome", "Sao Paulo", "Seoul", "Shanghai", "Singapore",
  "Sydney", "Tokyo", "Toronto", "Vancouver",
]);

function timezoneCity(id: string): string {
  const city = id.split("/").at(-1)!;
  // ICU can still list older IANA spellings.
  return city === "Calcutta" ? "Kolkata" : city.replaceAll("_", " ");
}

function timezoneOffset(id: string, at: Date): { seconds: number; label: string } {
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: "longOffset" })
    .formatToParts(at).find(({ type }) => type === "timeZoneName")!.value;
  const [, sign = "+", hours = "0", minutes = "00", seconds = "00"] =
    /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(offset) ?? [];
  const total = (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * (sign === "-" ? -1 : 1);
  const suffix = seconds !== "00" ? `:${minutes}:${seconds}` : minutes !== "00" ? `:${minutes}` : "";
  return { seconds: total, label: total === 0 ? "UTC" : `UTC${sign}${Number(hours)}${suffix}` };
}

export function timezoneLabel(id: string, at = new Date()): string {
  const { label } = timezoneOffset(id, at);
  const city = timezoneCity(id);
  return city === label ? label : `${label} (${city})`;
}

export function timezoneOffsetGroups(current: string, at = new Date()): TimezoneOffsetGroup[] {
  // UTC and already configured aliases aren't necessarily listed by ICU.
  const ids = new Set(["UTC", ...Intl.supportedValuesOf("timeZone"), current]);
  const groups = new Map<number, TimezoneOffsetGroup>();
  for (const id of ids) {
    const { seconds, label } = timezoneOffset(id, at);
    let group = groups.get(seconds);
    if (!group) {
      group = { offset: label, label, zones: [] };
      groups.set(seconds, group);
    }
    group.zones.push({ id, city: timezoneCity(id) });
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => {
    group.zones.sort((a, b) => a.city.localeCompare(b.city, "en") || a.id.localeCompare(b.id, "en"));
    const cities = [...new Set(group.zones.map(({ city }) => city).filter((city) => city !== group.offset))];
    const examples = [...cities.filter((city) => exampleCities.has(city)), ...cities.filter((city) => !exampleCities.has(city))];
    if (examples.length) group.label = `${group.offset} (${examples.slice(0, 2).join(", ")})`;
    return group;
  });
}

export async function selectGatewayTimezone(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
  const groups = timezoneOffsetGroups(current);
  const currentGroup = groups.find((group) => group.zones.some(({ id }) => id === current));
  let selectedOffset = currentGroup?.offset;
  while (true) {
    selectedOffset = await selectGatewayOption(ctx, {
      title: "Timezone · Choose a UTC offset",
      description: "Offsets are shown for now. The city you choose follows its local time rules, including daylight saving.",
      options: groups.map(({ offset, label }) => ({ value: offset, label, current: offset === currentGroup?.offset })),
      selectedOption: selectedOffset,
    });
    const group = groups.find(({ offset }) => offset === selectedOffset);
    if (!group) return;

    const cityCounts = new Map<string, number>();
    for (const { city } of group.zones) cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1);
    const zone = await selectGatewayOption(ctx, {
      title: `Timezone · ${group.offset} · Choose a city`,
      options: group.zones.map(({ id, city }) => ({
        value: id,
        label: cityCounts.get(city) === 1 ? city : `${city} (${id})`,
        description: id === city ? undefined : id,
        current: id === current,
      })),
    });
    if (zone !== undefined) return zone;
  }
}
