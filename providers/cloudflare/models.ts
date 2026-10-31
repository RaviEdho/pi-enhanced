import { fetchAccountList, isRecord } from "./api.js";
import type { CloudflareCatalogModel, CloudflareConnection } from "./types.js";

/** Parse both documented property arrays and property maps without assuming missing flags are false. */
export function parseCloudflareModel(value: unknown): CloudflareCatalogModel {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Invalid Cloudflare model catalog entry");
  }
  if (!Array.isArray(value.properties) && !isRecord(value.properties)) {
    throw new Error("Cloudflare model is missing property metadata");
  }
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (Array.isArray(value.properties)) {
    const conflicts = new Set<string>();
    for (const property of value.properties) {
      if (isRecord(property) && typeof property.property_id === "string") {
        // Contradictory duplicate values are not trustworthy.
        const key = property.property_id;
        if (conflicts.has(key)) continue;
        if (Object.hasOwn(properties, key) && properties[key] !== property.value) {
          properties[key] = undefined;
          conflicts.add(key);
        } else properties[key] = property.value;
      }
    }
  } else if (isRecord(value.properties)) {
    Object.assign(properties, value.properties);
  }
  const flag = properties.require_workers_paid;
  const requiresWorkersPaid = flag === true || flag === "true" ? true : flag === false || flag === "false" ? false : undefined;
  return { id: value.name, raw: value, properties, requiresWorkersPaid };
}

/** Fetch the authenticated, dynamically discovered Workers AI catalog. */
export async function fetchCloudflareModels(connection: CloudflareConnection): Promise<CloudflareCatalogModel[]> {
  const rows = await fetchAccountList(connection, "ai/models/search");
  const models = rows.map(parseCloudflareModel);
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`Duplicate Cloudflare model: ${model.id}`);
    seen.add(model.id);
  }
  return models;
}
