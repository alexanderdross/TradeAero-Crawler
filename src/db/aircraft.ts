import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { extractStructuredData, applyExtractedData } from "../utils/extract.js";
import { generateSlug } from "../utils/slug.js";
import { LANGS, buildLocaleFields } from "./locale-helpers.js";
import { lookupReferenceSpecs, applyReferenceSpecs, lookupCategoryFromRefSpecs } from "./reference-specs.js";
import type { ParsedAircraftListing } from "../types.js";
import { stripTitleDatePrefix } from "../parsers/shared.js";

let manufacturerCache: Map<string, number> | null = null;
let refSpecManufacturers: string[] | null = null;

/**
 * Map legacy / alternate manufacturer names to the canonical name used in
 * aircraft_reference_specs.  When a listing title contains an alias (left),
 * we resolve it to the canonical name (right) so that category lookup and
 * reference-spec enrichment work correctly.
 *
 * Sorted longest-first so "AgustaWestland" matches before "Agusta".
 */
const MANUFACTURER_ALIASES: Record<string, string> = {
  // AgustaWestland → rebranded to Leonardo Helicopters in 2016
  "agustawestland": "Leonardo",
  "agusta westland": "Leonardo",
  "agusta": "Leonardo",
  // Eurocopter → rebranded to Airbus Helicopters in 2014
  "eurocopter": "Airbus Helicopters",
  // MBB → merged into Eurocopter, now Airbus Helicopters
  "mbb": "Airbus Helicopters",
  // Aerospatiale helicopters → Airbus Helicopters
  "aerospatiale": "Airbus Helicopters",
  // Sikorsky alternate
  "sikorski": "Sikorsky",
  // Hawker Beechcraft → split into Beechcraft (pistons) and Hawker (jets)
  "hawker beechcraft": "Beechcraft",
  // Daher-Socata → Daher acquired Socata
  "daher-socata": "Daher",
  "daher socata": "Daher",
  // De Havilland alternate spellings
  "dehavilland": "De Havilland",
  "de havilland canada": "De Havilland",
  // Vulcanair ← Partenavia
  "partenavia": "Vulcanair",
};

/** Sorted alias keys longest-first for greedy matching */
const ALIAS_KEYS = Object.keys(MANUFACTURER_ALIASES).sort((a, b) => b.length - a.length);

async function loadRefSpecManufacturers(): Promise<string[]> {
  if (refSpecManufacturers) return refSpecManufacturers;
  const { data } = await (supabase as any).from("aircraft_reference_specs").select("manufacturer");
  const raw: string[] = (data ?? []).map((r: any) => r.manufacturer as string).filter(Boolean);
  refSpecManufacturers = [...new Set(raw)].sort((a, b) => b.length - a.length);
  return refSpecManufacturers;
}

async function getManufacturerMap(): Promise<Map<string, number>> {
  if (manufacturerCache) return manufacturerCache;
  const { data } = await supabase.from("aircraft_manufacturers").select("id, name");
  manufacturerCache = new Map((data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  return manufacturerCache;
}

async function resolveManufacturer(title: string): Promise<string | null> {
  const lower = title.toLowerCase();

  // 1. Check manufacturer aliases first (handles rebrands like Agusta → Leonardo)
  for (const alias of ALIAS_KEYS) {
    if (lower.includes(alias)) return MANUFACTURER_ALIASES[alias];
  }

  // 2. Match against reference-spec manufacturer names
  const manufacturers = await loadRefSpecManufacturers();
  for (const m of manufacturers) { if (lower.includes(m.toLowerCase())) return m; }
  return null;
}

// ---------------------------------------------------------------------------
// Category detection: uses aircraft_reference_specs table as source of truth,
// falls back to URL/title keyword heuristics for unknown manufacturers.
// ---------------------------------------------------------------------------

function detectCategoryFromUrlAndTitle(sourceUrl: string | undefined, title: string): string | null {
  const url = (sourceUrl ?? "").toLowerCase();
  const t = title.toLowerCase();
  if (url.includes("/hubschrauber") || url.includes("/helicopter") || t.includes("helicopter") ||
      t.includes("hubschrauber") || t.includes("gyrocopter") || t.includes("autogyro")) return "Helicopter / Gyrocopter";
  if (url.includes("/segelflugzeug") || url.includes("/glider") || t.includes("glider") ||
      t.includes("segelflugzeug") || t.includes("sailplane") || t.includes("motorsegler") ||
      t.includes("motor glider")) return "Glider";
  if (url.includes("/turboprop") || t.includes("turboprop") || t.includes("turbo prop")) return "Turboprop";
  if (url.includes("/jet") || t.includes(" jet") || t.match(/\bjet\b/)) return "Jet";
  if (url.includes("/ul-") || url.includes("/ultraleicht") || url.includes("ul-flugzeug") ||
      url.includes("helmuts-ul-seiten.de") || t.includes("ultralight") || t.includes("ultraleicht") ||
      t.includes(" ul ") || t.match(/\bul\b/)) return "Ultralight / Light Sport Aircraft (LSA)";
  return null;
}

async function detectCategoryName(sourceUrl: string | undefined, title: string, manufacturerName?: string | null): Promise<string | null> {
  // 1. Reference specs lookup takes priority — the table has correct category
  //    for every known manufacturer+model combo (475+ entries).
  //    This prevents e.g. Mooney/Piper/Agusta being miscategorized as LSA
  //    just because they appear on helmuts-ul-seiten.de.
  const refCategory = await lookupCategoryFromRefSpecs(title, manufacturerName ?? null);
  if (refCategory) return refCategory;

  // 2. Fallback to URL/title keyword heuristics (for new/unknown manufacturers)
  return detectCategoryFromUrlAndTitle(sourceUrl, title);
}

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

export async function upsertAircraftListing(
  listing: ParsedAircraftListing,
  systemUserId: string,
): Promise<"inserted" | "updated" | "skipped"> {
  try {
    logger.info(`Processing listing: ${listing.title}`);

    if (!listing.imageUrls || listing.imageUrls.length === 0) {
      logger.debug(`Skipping listing with no images: "${listing.title}"`);
      return "skipped";
    }

    const cleanTitle = stripTitleDatePrefix(listing.title);

    const manufacturerName = await resolveManufacturer(cleanTitle);
    const manufacturerMap = await getManufacturerMap();
    const manufacturerId = manufacturerName
      ? (manufacturerMap.get(manufacturerName.toLowerCase()) ?? null) : null;

    const refSpecs = await lookupReferenceSpecs(cleanTitle, listing.description ?? "", listing.engine ?? null);

    const detectedCategoryName = await detectCategoryName(listing.sourceUrl, cleanTitle, manufacturerName);
    const categoryId = detectedCategoryName ? await getCategoryId(detectedCategoryName) : null;

    // Dedup
    const { data: existing } = await supabase
      .from("aircraft_listings").select("id").eq("source_url", listing.sourceId).maybeSingle();

    // Images (new listings only)
    const images = existing ? [] : await uploadImages(listing.imageUrls, cleanTitle, "aircraft-images");

    // Extract structured data from description
    const extracted = await extractStructuredData(cleanTitle, listing.description ?? "");

    // Use cleaned description for translation (specs removed)
    const descForTranslation = extracted?.cleaned_description ?? listing.description ?? "";

    // Translations
    let translations: TranslationResult | null = null;
    if (process.env.ANTHROPIC_API_KEY && descForTranslation) {
      try {
        translations = await translateListing(cleanTitle, descForTranslation, "de");
      } catch (err) {
        logger.warn(`Translation failed for "${cleanTitle}": ${err}`);
      }
    }

    const localeFields = buildLocaleFields(cleanTitle, descForTranslation, translations);

    // Build record
    const record: Record<string, unknown> = {
      user_id: systemUserId,
      headline: cleanTitle,
      description: descForTranslation,
      year: listing.year ?? null,
      price: listing.price ?? null,
      currency: "EUR",
      price_negotiable: listing.priceNegotiable,
      total_time: listing.totalTime ?? null,
      engine_hours: listing.engineHours ?? null,
      engine_type_name: listing.engine ?? null,
      location: listing.location ?? null,
      country: listing.country ?? "Germany",
      city: listing.city ?? null,
      icaocode: listing.icaoCode ?? null,
      registration: listing.registration ?? null,
      serial_number: listing.serialNumber ?? null,
      manufacturer_id: manufacturerId,
      category_id: categoryId,
      status: "active",
      source_name: listing.sourceName,
      source_url: listing.sourceId,
      is_external: true,
      contact_name: listing.contactName ?? listing.sourceName,
      contact_email: listing.contactEmail ?? "noreply@trade.aero",
      contact_phone: listing.contactPhone ?? "",
      seats: "2",
      fuel_type: listing.fuelType ?? null,
      empty_weight: listing.emptyWeight ? String(listing.emptyWeight) : null,
      max_takeoff_weight: listing.maxTakeoffWeight ? String(listing.maxTakeoffWeight) : null,
      fuel_capacity: listing.fuelCapacity ? String(listing.fuelCapacity) : null,
      cruise_speed: listing.cruiseSpeed ? String(listing.cruiseSpeed) : null,
      max_speed: listing.maxSpeed ? String(listing.maxSpeed) : null,
      max_range: listing.maxRange ? String(listing.maxRange) : null,
      service_ceiling: listing.serviceCeiling ? String(listing.serviceCeiling) : null,
      auto_translate: false,
      headline_auto_translate: false,
      agree_to_terms: true,
      ...localeFields,
    };

    if (listing.avionicsText) record.avionics_other = listing.avionicsText;

    // Apply extracted structured data (fills engine, avionics, equipment, etc.)
    if (extracted) applyExtractedData(record, extracted);

    // Apply reference specs (fills remaining missing performance data)
    if (refSpecs) applyReferenceSpecs(record, refSpecs);

    // Images
    if (images.length > 0) {
      record.images = images.map((img: any, idx: number) => {
        const enriched: Record<string, unknown> = {
          url: img.url, alt_text: img.alt_text || cleanTitle, auto_translate: false, sort_order: idx,
        };
        for (const lang of LANGS) {
          const t = translations?.[lang];
          enriched[`alt_text_${lang}`] = t?.headline ? `${t.headline} - Image ${idx + 1}` : `${cleanTitle} - Image ${idx + 1}`;
        }
        return enriched;
      });
    }

    // Upsert
    if (existing) {
      const updateFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (/^(headline|description|slug)_(en|de|fr|es|it|pl|cs|sv|nl|pt|ru|tr|el|no)$/.test(key)) continue;
        if (key === "slug" || key === "images") continue;
        updateFields[key] = value;
      }
      const { error } = await supabase.from("aircraft_listings")
        .update({ ...updateFields, updated_at: new Date().toISOString() }).eq("id", existing.id);
      if (error) { logger.error(`Failed to update aircraft "${cleanTitle}": ${error.message}`); return "skipped"; }
      logger.info(`Updated aircraft id=${existing.id} title="${cleanTitle}"`);
      return "updated";
    }

    const { data: inserted, error } = await supabase.from("aircraft_listings")
      .insert(record).select("id, slug, listing_number").single();
    if (error) {
      const level = error.message?.includes("check constraint") ? "warn" : "error";
      logger[level](`Failed to insert aircraft "${cleanTitle}": ${error.message}`);
      return "skipped";
    }

    // Localized slugs
    const listingNum = (inserted as any).listing_number ?? null;
    if (listingNum && translations) {
      const slugUpdate: Record<string, string> = {};
      if ((inserted as any).slug) slugUpdate.slug_en = (inserted as any).slug;
      for (const lang of LANGS) {
        if (lang === "en") continue;
        const hl = (record as Record<string, unknown>)[`headline_${lang}`];
        if (hl && typeof hl === "string" && hl.trim()) slugUpdate[`slug_${lang}`] = generateSlug(hl, listingNum);
      }
      if (Object.keys(slugUpdate).length > 0)
        await supabase.from("aircraft_listings").update(slugUpdate).eq("id", (inserted as any).id);
    }

    logger.info(`Inserted aircraft id=${(inserted as any).id} title="${cleanTitle}"`);

    if (manufacturerName) await seedReferenceEntry(manufacturerName, cleanTitle);
    return "inserted";
  } catch (err) {
    logger.error(`Unexpected error in upsertAircraftListing: ${err}`);
    return "skipped";
  }
}

export const upsertAircraft = upsertAircraftListing;
export { LANGS };

export async function ensureManufacturer(name: string): Promise<number | null> {
  try {
    const map = await getManufacturerMap();
    const cached = map.get(name.toLowerCase());
    if (cached !== undefined) return cached;
    const { data, error } = await supabase.from("aircraft_manufacturers")
      .upsert({ name }, { onConflict: "name" }).select("id").single();
    if (error || !data) { logger.warn(`Failed to ensure manufacturer "${name}": ${error?.message}`); return null; }
    map.set(name.toLowerCase(), data.id);
    return data.id;
  } catch (err) { logger.warn(`Error ensuring manufacturer "${name}": ${err}`); return null; }
}

async function seedReferenceEntry(manufacturer: string, title: string): Promise<void> {
  try {
    const model = title.replace(new RegExp(manufacturer, "i"), "").trim().slice(0, 100) || "Unknown";
    await (supabase as any).from("aircraft_reference_specs")
      .upsert({ manufacturer, model, variant: null, notes: `Auto-seeded: "${title.slice(0, 200)}"` },
        { onConflict: "manufacturer,model,variant", ignoreDuplicates: true });
  } catch { /* non-critical */ }
}
