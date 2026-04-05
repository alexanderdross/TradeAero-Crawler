import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";

interface ReferenceSpec {
  cruise_speed: string | null;
  cruise_speed_unit: string | null;
  max_speed: string | null;
  max_speed_unit: string | null;
  max_range: string | null;
  max_range_unit: string | null;
  service_ceiling: string | null;
  service_ceiling_unit: string | null;
  climb_rate: string | null;
  climb_rate_unit: string | null;
  takeoff_distance: string | null;
  takeoff_distance_unit: string | null;
  landing_distance: string | null;
  landing_distance_unit: string | null;
  fuel_consumption: string | null;
  fuel_consumption_unit: string | null;
  empty_weight: string | null;
  empty_weight_unit: string | null;
  max_takeoff_weight: string | null;
  max_takeoff_weight_unit: string | null;
  max_payload: string | null;
  max_payload_unit: string | null;
  fuel_capacity: string | null;
  fuel_capacity_unit: string | null;
  engine_type: string | null;
  engine_power: string | null;
  engine_power_unit: string | null;
  fuel_type: string | null;
  seats: string | null;
}

/** Cache all reference specs on first load */
let specsCache: Array<{
  manufacturer: string;   // lowercase (for matching)
  model: string;          // lowercase (for matching)
  variant: string;        // lowercase (for matching)
  manufacturer_orig: string; // original casing (for display)
  model_orig: string;        // original casing (for display)
  variant_orig: string;      // original casing (for display)
  specs: ReferenceSpec;
}> | null = null;

async function loadCache(): Promise<typeof specsCache> {
  if (specsCache) return specsCache;

  const { data, error } = await supabase
    .from("aircraft_reference_specs")
    .select("*");

  if (error) {
    logger.warn("Failed to load reference specs", { error: error.message });
    specsCache = [];
    return specsCache;
  }

  specsCache = (data ?? []).map((row) => ({
    manufacturer: (row.manufacturer ?? "").toLowerCase(),
    model: (row.model ?? "").toLowerCase(),
    variant: (row.variant ?? "").toLowerCase(),
    manufacturer_orig: (row.manufacturer ?? ""),
    model_orig: (row.model ?? ""),
    variant_orig: (row.variant ?? ""),
    specs: row as ReferenceSpec,
  }));

  logger.info(`Loaded ${specsCache.length} reference specs`);
  return specsCache;
}

/**
 * Look up reference performance specs for an aircraft based on its title/description.
 * Returns matching spec fields or null if no match found.
 *
 * Matching strategy:
 * 1. Try manufacturer + model + variant (exact match)
 * 2. Try manufacturer + model (any variant)
 * 3. Try model name appearing anywhere in the title
 */
export async function lookupReferenceSpecs(
  title: string,
  description: string,
  extractedEngine: string | null
): Promise<Partial<ReferenceSpec> | null> {
  const cache = await loadCache();
  if (!cache || cache.length === 0) return null;

  const text = `${title} ${description} ${extractedEngine ?? ""}`.toLowerCase();

  // Strategy 1 & 2: Find best match by manufacturer + model
  let bestMatch: ReferenceSpec | null = null;
  let bestScore = 0;

  for (const entry of cache) {
    let score = 0;

    // Check manufacturer presence in text
    if (text.includes(entry.manufacturer)) score += 2;

    // Check model presence in text.
    // Short models (≤3 chars, e.g. "8", "J3") must match as whole words to prevent
    // false positives like "8" matching inside "383 Hours" or "2008".
    const modelTerm = entry.model;
    let modelInText: boolean;
    if (modelTerm.length <= 3) {
      const escaped = modelTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      modelInText = new RegExp(`\\b${escaped}\\b`).test(text);
    } else {
      modelInText = text.includes(modelTerm);
    }
    if (modelInText) score += 3;

    // Bonus for variant match
    if (entry.variant && text.includes(entry.variant)) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry.specs;
    }
  }

  // Require at least model match (score >= 3)
  if (bestScore >= 3 && bestMatch) {
    const matchEntry = cache.find(e => e.specs === bestMatch)!;
    logger.debug("Matched reference specs", { title: title.slice(0, 50), score: bestScore, model: matchEntry.model });
    // Attach clean manufacturer/model/variant from reference data (original casing for display)
    const result: Partial<ReferenceSpec> & { ref_manufacturer?: string; ref_model?: string; ref_variant?: string } = { ...bestMatch };
    result.ref_manufacturer = matchEntry.manufacturer_orig;
    result.ref_model = matchEntry.model_orig;
    result.ref_variant = matchEntry.variant_orig || undefined;
    return result;
  }

  return null;
}

/**
 * Apply reference specs to a listing record, only filling null/missing fields.
 * Does NOT overwrite values already extracted from the listing.
 */
export function applyReferenceSpecs(
  record: Record<string, unknown>,
  refSpecs: Partial<ReferenceSpec>
): Record<string, unknown> {
  const enriched = { ...record };

  // Performance fields
  const mappings: Array<[string, keyof ReferenceSpec, string?, string?]> = [
    ["cruise_speed", "cruise_speed", "cruise_speed_unit", "cruise_speed_unit"],
    ["max_speed", "max_speed", "max_speed_unit", "max_speed_unit"],
    ["max_range", "max_range", "max_range_unit", "max_range_unit"],
    ["service_ceiling", "service_ceiling", "service_ceiling_unit", "service_ceiling_unit"],
    ["performance_climb_rate", "climb_rate", "performance_climb_rate_unit", "climb_rate_unit"],
    ["performance_takeoff_distance", "takeoff_distance", "performance_takeoff_distance_unit", "takeoff_distance_unit"],
    ["performance_landing_distance", "landing_distance", "performance_landing_distance_unit", "landing_distance_unit"],
    ["performance_fuel_consumption", "fuel_consumption", "performance_fuel_consumption_unit", "fuel_consumption_unit"],
    ["empty_weight", "empty_weight", "empty_weight_unit", "empty_weight_unit"],
    ["max_takeoff_weight", "max_takeoff_weight", "max_takeoff_weight_unit", "max_takeoff_weight_unit"],
    ["max_payload", "max_payload", "max_payload_unit", "max_payload_unit"],
    ["fuel_capacity", "fuel_capacity", "fuel_capacity_unit", "fuel_capacity_unit"],
  ];

  for (const [dbField, specField, dbUnitField, specUnitField] of mappings) {
    if (!enriched[dbField] && refSpecs[specField]) {
      enriched[dbField] = refSpecs[specField];
      if (dbUnitField && specUnitField && !enriched[dbUnitField] && refSpecs[specUnitField as keyof ReferenceSpec]) {
        enriched[dbUnitField] = refSpecs[specUnitField as keyof ReferenceSpec];
      }
    }
  }

  // Engine fields — only fill if not already set
  if (!enriched["engine_type_name"] && refSpecs.engine_type) {
    enriched["engine_type_name"] = refSpecs.engine_type;
  }
  if (!enriched["engine_power"] && refSpecs.engine_power) {
    enriched["engine_power"] = refSpecs.engine_power;
  }
  if (!enriched["engine_power_unit"] && refSpecs.engine_power_unit) {
    enriched["engine_power_unit"] = refSpecs.engine_power_unit;
  }
  if (!enriched["fuel_type"] && refSpecs.fuel_type) {
    enriched["fuel_type"] = refSpecs.fuel_type;
  }
  if (!enriched["seats"] && refSpecs.seats) {
    enriched["seats"] = refSpecs.seats;
  }

  return enriched;
}
