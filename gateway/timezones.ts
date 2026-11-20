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
