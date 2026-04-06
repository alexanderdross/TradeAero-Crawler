import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
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
  refSpecManufacturers = unique.sort((a: string, b: string) => b.length - a.length);
  return refSpecManufacturers;
}

async function getManufacturerMap(): Promise<Map<string, number>> {
  if (manufacturerCache) return manufacturerCache;
  const { data } = await supabase.from("aircraft_manufacturers").select("id, name");
  manufacturerCache = new Map((data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  return manufacturerCache;
}

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

function detectCategoryName(
  sourceUrl: string | undefined,
  title: string,
): string | null {
  const url = (sourceUrl ?? "").toLowerCase();
  const t = title.toLowerCase();

  if (
    url.includes("/ul-") || url.includes("/ultraleicht") ||
    url.includes("ul-flugzeug") || url.includes("helmuts-ul-seiten.de") ||
    t.includes("ultralight") || t.includes("ultraleicht") ||
    t.includes(" ul ") || t.match(/\bul\b/)
  ) {
    return "LSA / Ultralight";
  }

  if (
    url.includes("/hubschrauber") || url.includes("/helicopter") ||
    t.includes("helicopter") || t.includes("hubschrauber") ||
    t.includes("gyrocopter") || t.includes("autogyro")
  ) {
    return "Helicopter";
  }

  if (
    url.includes("/segelflugzeug") || url.includes("/glider") ||
    t.includes("glider") || t.includes("segelflugzeug") ||
    t.includes("sailplane") || t.includes("motorsegler") || t.includes("motor glider")
  ) {
    return "Glider / Motor Glider";
  }

  if (url.includes("/turboprop") || t.includes("turboprop") || t.includes("turbo prop")) {
    return "Turboprop";
  }

  if (url.includes("/jet") || t.includes(" jet") || t.match(/\bjet\b/)) {
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

export async function upsertAircraftListing(
  listing: ParsedAircraftListing,
  systemUserId: string,
): Promise<"inserted" | "updated" | "skipped"> {
  try {
    logger.info(`Processing listing: ${listing.title}`);

    // ------------------------------------------------------------------
    // 0.  Skip external listings with no images (low quality, not publishable)
    // ------------------------------------------------------------------
    if (!listing.imageUrls || listing.imageUrls.length === 0) {
      logger.debug(`Skipping listing with no images: "${listing.title}"`);
      return "skipped";
    }

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
    const detectedCategoryName = detectCategoryName(listing.sourceUrl, cleanTitle);
    const categoryId = detectedCategoryName
      ? await getCategoryId(detectedCategoryName)
      : null;

    // ------------------------------------------------------------------
    // 5.  Dedup check
    // ------------------------------------------------------------------
    const { data: existing } = await supabase
      .from("aircraft_listings")
      .select("id")
      .eq("source_url", listing.sourceId)
      .maybeSingle();

    // ------------------------------------------------------------------
    // 6.  Images (only for new listings)
    // ------------------------------------------------------------------
    const images = existing
      ? []
      : await uploadImages(listing.imageUrls, cleanTitle, "aircraft-images");

    // ------------------------------------------------------------------
    // 7.  Translations
    // ------------------------------------------------------------------
    let translations: TranslationResult | null = null;
    if (process.env.ANTHROPIC_API_KEY && listing.description) {
      try {
        translations = await translateListing(cleanTitle, listing.description, "de");
      } catch (err) {
        logger.warn(`Translation failed for "${cleanTitle}": ${err}`);
      }
    }

    // Build locale title/description fields
    const localeFields = buildLocaleFields(cleanTitle, listing.description ?? "", translations);

    // ------------------------------------------------------------------
    // 8.  Build aircraft record
    // ------------------------------------------------------------------
    const record: Record<string, unknown> = {
      user_id: systemUserId,
      headline: cleanTitle,
      description: listing.description ?? "",
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
      seats: listing.avionicsText ? undefined : "2",
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

    // Only include images for new listings
    if (images.length > 0) {
      record.images = images.map((img: any, idx: number) => {
        const enriched: Record<string, unknown> = {
          url: img.url,
          alt_text: img.alt_text || cleanTitle,
          auto_translate: false,
          sort_order: idx,
        };
        for (const lang of LANGS) {
          const t = translations?.[lang];
          enriched[`alt_text_${lang}`] = t?.headline
            ? `${t.headline} - Image ${idx + 1}`
            : `${cleanTitle} - Image ${idx + 1}`;
        }
        return enriched;
      });
    }

    // Avionics fields
    if (listing.avionicsText) {
      record.avionics_other = listing.avionicsText;
    }

    // ------------------------------------------------------------------
    // 9.  Apply reference specs (fills missing performance data)
    // ------------------------------------------------------------------
    if (refSpecs) {
      applyReferenceSpecs(record, refSpecs);
    }

    // ------------------------------------------------------------------
    // 10. Upsert
    // ------------------------------------------------------------------
    if (existing) {
      // UPDATE — skip images and slug fields
      const updateFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (/^(headline|description|slug)_(en|de|fr|es|it|pl|cs|sv|nl|pt|ru|tr|el|no)$/.test(key)) continue;
        if (key === "slug" || key === "images") continue;
        updateFields[key] = value;
      }

      const { error } = await supabase
        .from("aircraft_listings")
        .update({ ...updateFields, updated_at: new Date().toISOString() })
        .eq("id", existing.id);

      if (error) {
        logger.error(`Failed to update aircraft "${cleanTitle}": ${error.message}`);
        return "skipped";
      }
      logger.info(`Updated aircraft id=${existing.id} title="${cleanTitle}"`);
      return "updated";
    }

    // INSERT
    const { data: inserted, error } = await supabase
      .from("aircraft_listings")
      .insert(record)
      .select("id, slug, listing_number")
      .single();

    if (error) {
      const level = error.message?.includes("check constraint") ? "warn" : "error";
      logger[level](`Failed to insert aircraft "${cleanTitle}": ${error.message}`);
      return "skipped";
    }

    // Generate localized slugs using DB-assigned listing_number
    const listingNum = (inserted as any).listing_number ?? null;
    if (listingNum && translations) {
      const slugUpdate: Record<string, string> = {};
      if ((inserted as any).slug) {
        slugUpdate.slug_en = (inserted as any).slug;
      }
      for (const lang of LANGS) {
        if (lang === "en") continue;
        const headline = (record as Record<string, unknown>)[`headline_${lang}`];
        if (headline && typeof headline === "string" && headline.trim()) {
          slugUpdate[`slug_${lang}`] = generateSlug(headline, listingNum);
        }
      }
      if (Object.keys(slugUpdate).length > 0) {
        await supabase.from("aircraft_listings").update(slugUpdate).eq("id", (inserted as any).id);
      }
    }

    logger.info(`Inserted aircraft id=${(inserted as any).id} title="${cleanTitle}"`);

    // ------------------------------------------------------------------
    // 11. Seed reference catalogue entry (best-effort)
    // ------------------------------------------------------------------
    if (manufacturerName) {
      await seedReferenceEntry(manufacturerName, cleanTitle);
    }

    return "inserted";
  } catch (err) {
    logger.error(`Unexpected error in upsertAircraftListing: ${err}`);
    return "skipped";
  }
}

// Legacy alias
export const upsertAircraft = upsertAircraftListing;

// ---------------------------------------------------------------------------
// Locale helpers (re-exported for convenience)
// ---------------------------------------------------------------------------

export { LANGS };

// ---------------------------------------------------------------------------
// Manufacturer helpers
// ---------------------------------------------------------------------------

export async function ensureManufacturer(name: string): Promise<number | null> {
  try {
    const map = await getManufacturerMap();
    const cached = map.get(name.toLowerCase());
    if (cached !== undefined) return cached;

    const { data, error } = await supabase
      .from("aircraft_manufacturers")
      .upsert({ name }, { onConflict: "name" })
      .select("id")
      .single();

    if (error || !data) {
      logger.warn(`Failed to ensure manufacturer "${name}": ${error?.message}`);
      return null;
    }

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

async function seedReferenceEntry(manufacturer: string, title: string): Promise<void> {
  try {
    const model = title.replace(new RegExp(manufacturer, "i"), "").trim().slice(0, 100) || "Unknown";
    const variant = null;

    await (supabase as any)
      .from("aircraft_reference_specs")
      .upsert({
        manufacturer,
        model,
        variant,
        notes: `Auto-seeded from listing title: "${title.slice(0, 200)}"`,
      }, { onConflict: "manufacturer,model,variant", ignoreDuplicates: true });
  } catch {
    // Non-critical
  }
}
