import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug } from "../utils/slug.js";
import { LANGS, buildLocaleFields } from "./locale-helpers.js";
import { lookupReferenceSpecs, applyReferenceSpecs } from "./reference-specs.js";
import type { ParsedAircraftListing } from "../types.js";
import { stripTitleDatePrefix } from "../parsers/shared.js";

/**
 * Known manufacturer names → their aircraft_manufacturers.id in the DB.
 * Looked up dynamically on first call and cached.
 */
let manufacturerCache: Map<string, number> | null = null;

/**
 * Unique manufacturer names from aircraft_reference_specs table (cached).
 * This is the single source of truth for valid manufacturer names.
 * No more hardcoded KNOWN_MANUFACTURERS list — reference specs has 610+ models.
 */
let refSpecManufacturers: string[] | null = null;

async function loadRefSpecManufacturers(): Promise<string[]> {
  if (refSpecManufacturers) return refSpecManufacturers;
  const { data } = await (supabase as any)
    .from("aircraft_reference_specs")
    .select("manufacturer");
  const raw: string[] = (data ?? []).map((r: any) => r.manufacturer as string).filter(Boolean);
  const unique = [...new Set(raw)];
  // Sort longest first for better matching (e.g. "Comco Ikarus" before "Ikarus")
  refSpecManufacturers = unique.sort((a: string, b: string) => b.length - a.length);
  return refSpecManufacturers;
}

async function getManufacturerMap(): Promise<Map<string, number>> {
  if (manufacturerCache) return manufacturerCache;
  const { data } = await supabase.from("aircraft_manufacturers").select("id, name");
  manufacturerCache = new Map((data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  return manufacturerCache;
}

/**
 * Resolve manufacturer from listing title.
 * Uses reference spec manufacturers as source of truth.
 */
async function resolveManufacturer(title: string): Promise<string | null> {
  const manufacturers = await loadRefSpecManufacturers();
  const lower = title.toLowerCase();
  for (const m of manufacturers) {
    if (lower.includes(m.toLowerCase())) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Category detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect a normalised category name from source metadata and listing title.
 * Returns one of the values in the aircraft_categories table, or null.
 */
function detectCategoryName(
  sourceUrl: string | undefined,
  title: string,
): string | null {
  const url = (sourceUrl ?? "").toLowerCase();
  const t = title.toLowerCase();

  // Explicit UL / LSA markers in URL path or title
  if (
    url.includes("/ul-") ||
    url.includes("/ultraleicht") ||
    url.includes("ul-flugzeug") ||
    url.includes("helmuts-ul-seiten.de") ||
    t.includes("ultralight") ||
    t.includes("ultraleicht") ||
    t.includes(" ul ") ||
    t.match(/\bul\b/)
  ) {
    return "LSA / Ultralight";
  }

  // Helicopter keywords
  if (
    url.includes("/hubschrauber") ||
    url.includes("/helicopter") ||
    t.includes("helicopter") ||
    t.includes("hubschrauber") ||
    t.includes("gyrocopter") ||
    t.includes("autogyro")
  ) {
    return "Helicopter";
  }

  // Glider / motorglider
  if (
    url.includes("/segelflugzeug") ||
    url.includes("/glider") ||
    t.includes("glider") ||
    t.includes("segelflugzeug") ||
    t.includes("sailplane") ||
    t.includes("motorsegler") ||
    t.includes("motor glider")
  ) {
    return "Glider / Motor Glider";
  }

  // Turboprop
  if (
    url.includes("/turboprop") ||
    t.includes("turboprop") ||
    t.includes("turbo prop")
  ) {
    return "Turboprop";
  }

  // Jet
  if (
    url.includes("/jet") ||
    t.includes(" jet") ||
    t.match(/\bjet\b/)
  ) {
    return "Jet";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Category lookup (DB)
// ---------------------------------------------------------------------------

let categoryCache: Map<string, number> | null = null;

async function getCategoryId(name: string): Promise<number | null> {
  if (!categoryCache) {
    const { data } = await supabase.from("aircraft_categories").select("id, name");
    categoryCache = new Map((data ?? []).map((c: any) => [c.name.toLowerCase(), c.id]));
  }
  return categoryCache.get(name.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Main upsert
// ---------------------------------------------------------------------------

export async function upsertAircraft(
  listing: ParsedAircraftListing,
  sourceUrl?: string,
): Promise<void> {
  try {
    logger.info(`Processing listing: ${listing.title}`);

    // ------------------------------------------------------------------
    // 1.  Strip date prefixes injected by some parsers
    // ------------------------------------------------------------------
    const cleanTitle = stripTitleDatePrefix(listing.title);

    // ------------------------------------------------------------------
    // 2.  Resolve manufacturer
    // ------------------------------------------------------------------
    const manufacturerName = await resolveManufacturer(cleanTitle);
    const manufacturerMap = await getManufacturerMap();
    const manufacturerId = manufacturerName
      ? (manufacturerMap.get(manufacturerName.toLowerCase()) ?? null)
      : null;

    // ------------------------------------------------------------------
    // 3.  Reference specs enrichment
    // ------------------------------------------------------------------
    const refSpecs = manufacturerName
      ? await lookupReferenceSpecs(manufacturerName, cleanTitle)
      : null;

    // ------------------------------------------------------------------
    // 4.  Category resolution
    // ------------------------------------------------------------------
    const detectedCategoryName = detectCategoryName(sourceUrl, cleanTitle);
    const categoryId = detectedCategoryName
      ? await getCategoryId(detectedCategoryName)
      : null;

    // ------------------------------------------------------------------
    // 5.  Build base aircraft record
    // ------------------------------------------------------------------
    const aircraft: Record<string, unknown> = {
      title: cleanTitle,
      price: listing.price ?? null,
      year: listing.year ?? null,
      hours: listing.hours ?? null,
      location: listing.location ?? null,
      description: listing.description ?? null,
      source_url: listing.url,
      source: listing.source,
      manufacturer_id: manufacturerId,
      category_id: categoryId,
      is_active: true,
      last_seen_at: new Date().toISOString(),
    };

    // ------------------------------------------------------------------
    // 6.  Apply reference specs (fills engine_type, range_nm, etc.)
    // ------------------------------------------------------------------
    if (refSpecs) {
      applyReferenceSpecs(aircraft, refSpecs);
    }

    // ------------------------------------------------------------------
    // 7.  Translations
    // ------------------------------------------------------------------
    let translations: TranslationResult | null = null;
    if (config.openai.apiKey && listing.description) {
      try {
        translations = await translateListing({
          title: cleanTitle,
          description: listing.description,
        });
      } catch (err) {
        logger.warn(`Translation failed for "${cleanTitle}": ${err}`);
      }
    }

    // Build locale title/description fields
    const localeFields = buildLocaleFields(
      cleanTitle,
      listing.description ?? "",
      translations,
    );
    Object.assign(aircraft, localeFields);

    // ------------------------------------------------------------------
    // 8.  Upsert aircraft row
    // ------------------------------------------------------------------
    const { data: upserted, error: upsertError } = await supabase
      .from("aircraft")
      .upsert(aircraft, { onConflict: "source_url" })
      .select("id")
      .single();

    if (upsertError) {
      logger.error(`Failed to upsert aircraft "${cleanTitle}": ${upsertError.message}`);
      return;
    }

    const aircraftId: number = upserted.id;
    logger.info(`Upserted aircraft id=${aircraftId} title="${cleanTitle}"`);

    // ------------------------------------------------------------------
    // 9.  Images
    // ------------------------------------------------------------------
    if (listing.images && listing.images.length > 0) {
      await handleImages(aircraftId, listing.images);
    }

    // ------------------------------------------------------------------
    // 10. Seed reference catalogue entry (best-effort)
    // ------------------------------------------------------------------
    if (manufacturerName) {
      await seedReferenceEntry(manufacturerName, cleanTitle);
    }
  } catch (err) {
    logger.error(`Unexpected error in upsertAircraft: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Image handling
// ---------------------------------------------------------------------------

async function handleImages(aircraftId: number, imageUrls: string[]): Promise<void> {
  try {
    // Check which images already exist for this aircraft
    const { data: existingImages } = await supabase
      .from("aircraft_images")
      .select("source_url")
      .eq("aircraft_id", aircraftId);

    const existingUrls = new Set((existingImages ?? []).map((img: any) => img.source_url));
    const newUrls = imageUrls.filter((url) => !existingUrls.has(url));

    if (newUrls.length === 0) {
      logger.info(`No new images for aircraft id=${aircraftId}`);
      return;
    }

    logger.info(`Uploading ${newUrls.length} new images for aircraft id=${aircraftId}`);

    // Upload images to storage
    const uploadedImages = await uploadImages(aircraftId, newUrls);

    if (uploadedImages.length === 0) {
      logger.warn(`No images successfully uploaded for aircraft id=${aircraftId}`);
      return;
    }

    // Insert image records
    const imageRecords = uploadedImages.map((img, index) => ({
      aircraft_id: aircraftId,
      source_url: img.sourceUrl,
      storage_path: img.storagePath,
      storage_url: img.storageUrl,
      display_order: index,
      is_primary: index === 0,
    }));

    const { error: imageError } = await supabase
      .from("aircraft_images")
      .upsert(imageRecords, { onConflict: "aircraft_id,source_url" });

    if (imageError) {
      logger.error(`Failed to insert images for aircraft id=${aircraftId}: ${imageError.message}`);
    } else {
      logger.info(`Inserted ${imageRecords.length} images for aircraft id=${aircraftId}`);
    }
  } catch (err) {
    logger.error(`Error handling images for aircraft id=${aircraftId}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Listing deactivation
// ---------------------------------------------------------------------------

/**
 * Mark aircraft listings as inactive if they haven't been seen recently.
 * This is called after each crawl run to clean up stale listings.
 */
export async function deactivateStaleListings(
  source: string,
  activeUrls: string[],
): Promise<void> {
  try {
    if (activeUrls.length === 0) {
      logger.warn(`deactivateStaleListings called with empty activeUrls for source=${source}`);
      return;
    }

    const { error } = await supabase
      .from("aircraft")
      .update({ is_active: false })
      .eq("source", source)
      .eq("is_active", true)
      .not("source_url", "in", `(${activeUrls.map((u) => `"${u}"`).join(",")})`);

    if (error) {
      logger.error(`Failed to deactivate stale listings for source=${source}: ${error.message}`);
    } else {
      logger.info(`Deactivated stale listings for source=${source}`);
    }
  } catch (err) {
    logger.error(`Error deactivating stale listings: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Locale helpers (re-exported for convenience)
// ---------------------------------------------------------------------------

export { LANGS };

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/**
 * Generate and persist a URL slug for an aircraft listing.
 * Called after upsert to ensure slugs are always set.
 */
export async function ensureSlug(aircraftId: number, title: string): Promise<void> {
  try {
    const slug = generateSlug(title, aircraftId);
    const { error } = await supabase
      .from("aircraft")
      .update({ slug })
      .eq("id", aircraftId)
      .is("slug", null);

    if (error) {
      logger.warn(`Failed to set slug for aircraft id=${aircraftId}: ${error.message}`);
    }
  } catch (err) {
    logger.warn(`Error ensuring slug for aircraft id=${aircraftId}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/**
 * Upsert multiple aircraft listings in sequence.
 * Errors on individual listings are caught and logged without stopping the batch.
 */
export async function upsertAircraftBatch(
  listings: ParsedAircraftListing[],
  sourceUrl?: string,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (const listing of listings) {
    try {
      await upsertAircraft(listing, sourceUrl);
      success++;
    } catch (err) {
      logger.error(`Batch upsert failed for "${listing.title}": ${err}`);
      failed++;
    }
  }

  logger.info(`Batch upsert complete: ${success} succeeded, ${failed} failed`);
  return { success, failed };
}

// ---------------------------------------------------------------------------
// Statistics / reporting
// ---------------------------------------------------------------------------

export async function getAircraftStats(): Promise<{
  total: number;
  active: number;
  bySource: Record<string, number>;
}> {
  const { data: allAircraft } = await supabase
    .from("aircraft")
    .select("id, is_active, source");

  const total = allAircraft?.length ?? 0;
  const active = allAircraft?.filter((a: any) => a.is_active).length ?? 0;
  const bySource: Record<string, number> = {};

  for (const a of allAircraft ?? []) {
    bySource[a.source] = (bySource[a.source] ?? 0) + 1;
  }

  return { total, active, bySource };
}

// ---------------------------------------------------------------------------
// Source URL helpers
// ---------------------------------------------------------------------------

/**
 * Check if a listing URL already exists in the database.
 * Returns the aircraft id if found, null otherwise.
 */
export async function findBySourceUrl(sourceUrl: string): Promise<number | null> {
  const { data } = await supabase
    .from("aircraft")
    .select("id")
    .eq("source_url", sourceUrl)
    .single();

  return data?.id ?? null;
}

/**
 * Get all active source URLs for a given crawl source.
 * Used to determine which listings have gone stale.
 */
export async function getActiveSourceUrls(source: string): Promise<string[]> {
  const { data } = await supabase
    .from("aircraft")
    .select("source_url")
    .eq("source", source)
    .eq("is_active", true);

  return (data ?? []).map((row: any) => row.source_url);
}

// ---------------------------------------------------------------------------
// Manufacturer helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a manufacturer exists in the aircraft_manufacturers table.
 * Returns the manufacturer id (existing or newly created).
 */
export async function ensureManufacturer(name: string): Promise<number | null> {
  try {
    // Check cache first
    const map = await getManufacturerMap();
    const cached = map.get(name.toLowerCase());
    if (cached !== undefined) return cached;

    // Insert if not found
    const { data, error } = await supabase
      .from("aircraft_manufacturers")
      .upsert({ name }, { onConflict: "name" })
      .select("id")
      .single();

    if (error || !data) {
      logger.warn(`Failed to ensure manufacturer "${name}": ${error?.message}`);
      return null;
    }

    // Update cache
    map.set(name.toLowerCase(), data.id);
    return data.id;
  } catch (err) {
    logger.warn(`Error ensuring manufacturer "${name}": ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reference catalogue seeding
// ---------------------------------------------------------------------------

/**
 * Seed a minimal entry in aircraft_reference_specs if the model is unknown.
 * This allows the reference catalogue to grow organically as new models appear.
 */
async function seedReferenceEntry(manufacturer: string, title: string): Promise<void> {
  try {
    // Extract model from title by removing manufacturer prefix
    const model = title.replace(new RegExp(manufacturer, "i"), "").trim().slice(0, 100) || "Unknown";
    const variant = null;

    // Only seed if not already present (upsert with ignoreDuplicates)
    await (supabase as any)
      .from("aircraft_reference_specs")
      .upsert({
        manufacturer,
        model,
        variant,
        notes: `Auto-seeded from listing title: "${title.slice(0, 200)}"`,
      }, { onConflict: "manufacturer,model,variant", ignoreDuplicates: true });
  } catch {
    // Non-critical — don't fail the crawl for reference seeding issues
  }
}
