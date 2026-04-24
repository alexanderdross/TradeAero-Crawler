import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";

/**
 * Cached lookup for aviation event_categories.code → id. Fetched once on
 * first call, reused for the rest of the crawl run.
 */
let cachedEventCategories: Map<string, number> | null = null;

async function loadEventCategories(): Promise<Map<string, number>> {
  if (cachedEventCategories) return cachedEventCategories;

  const { data, error } = await supabase
    .from("event_categories")
    .select("id, code");

  if (error) {
    throw new Error(`Failed to load event_categories: ${error.message}`);
  }

  const map = new Map<string, number>();
  for (const row of data ?? []) {
    map.set(row.code, row.id);
  }
  cachedEventCategories = map;
  logger.debug("Loaded event categories", { count: map.size, codes: [...map.keys()] });
  return map;
}

/**
 * Resolve an event_categories.code to its numeric id. Throws if the code
 * is unknown — callers rely on the companion refactor migration
 * (`20260424_vereinsflieger_event_support.sql`) adding any new codes.
 */
export async function getEventCategoryIdByCode(code: string): Promise<number> {
  const map = await loadEventCategories();
  const id = map.get(code);
  if (id == null) {
    throw new Error(
      `Unknown event_categories.code='${code}'. ` +
        "Did you apply the vereinsflieger support migration?",
    );
  }
  return id;
}

/** Test helper — reset the in-memory cache between test runs. */
export function __resetEventCategoriesCache(): void {
  cachedEventCategories = null;
}
