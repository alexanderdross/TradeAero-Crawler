import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug, generateLocalizedSlugs } from "../utils/slug.js";
import type { ParsedAircraftListing } from "../types.js";

/**
 * Known manufacturer names → their aircraft_manufacturers.id in the DB.
 * Looked up dynamically on first call and cached.
 */
let manufacturerCache: Map<string, number> | null = null;

async function getManufacturerMap(): Promise<Map<string, number>> {
  if (manufacturerCache) return manufacturerCache;
  const { data } = await supabase.from("aircraft_manufacturers").select("id, name");
  manufacturerCache = new Map((data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  return manufacturerCache;
}

/**
 * Resolve manufacturer from listing title.
 * Returns { id, name } if matched, or { id: null, name: extracted } if not.
 */
async function resolveManufacturer(title: string): Promise<{ id: number | null; name: string }> {
  const mfgMap = await getManufacturerMap();
  const titleLower = title.toLowerCase();

  // Check all known manufacturers against the title
  for (const [name, id] of mfgMap.entries()) {
    if (titleLower.includes(name)) {
      return { id, name: [...mfgMap.entries()].find(([, v]) => v === id)?.[0] ?? name };
    }
  }

  // Fallback: first significant word
  const words = title.replace(/^\d{2}\.\d{2}\.\d{4}\s*/, "").split(/\s+/);
  const firstWord = words.find((w) => w.length > 2 && !/^\d+$/.test(w) && !["update", "verkaufe", "zu"].includes(w.toLowerCase()));
  return { id: null, name: firstWord ?? "Unknown" };
}

/**
 * Extract a model name from the title (everything after the manufacturer/date prefix).
 */
function extractModel(title: string, manufacturerName: string): string {
  // Remove date prefix like "21.11.2025 " or "Update 22.06.2025 "
  let cleaned = title
    .replace(/^(?:update\s+)?\d{2}\.\d{2}\.\d{4}\s*/i, "")
    .trim();

  // If manufacturer is in the cleaned title, take the rest as model
  const mfgIdx = cleaned.toLowerCase().indexOf(manufacturerName.toLowerCase());
  if (mfgIdx >= 0) {
    cleaned = cleaned.slice(mfgIdx + manufacturerName.length).trim();
    // Take first few words as model (up to a natural break like " - " or "with" or long text)
    const modelMatch = cleaned.match(/^([^-–—]+)/);
    if (modelMatch) return `${manufacturerName} ${modelMatch[1].trim()}`.slice(0, 100);
  }

  return cleaned.slice(0, 100) || title.slice(0, 100);
}

/**
 * Detect aircraft category from Helmut's UL Seiten content.
 * Most listings are ultralight / light sport aircraft.
 *
 * Category IDs from aircraft_categories table:
 *  1=Single Engine Piston, 2=Multi Engine Piston, 9=Turboprop,
 * 10=Helicopter, 11=Light Sport Aircraft, 13=Other
 */
function detectCategoryId(title: string, description: string): number {
  const text = `${title} ${description}`.toLowerCase();

  if (/gyrocopter|tragschrauber|autogyro/i.test(text)) return 10; // Helicopter (closest)
  if (/motorschirm|paramotor|gleitschirm|paraglider|trike/i.test(text)) return 13; // Other
  if (/hubschrauber|helicopter|heli\b/i.test(text)) return 10; // Helicopter
  if (/turboprop/i.test(text)) return 9; // Turboprop
  if (/motorsegler|touring motor glider|tmg/i.test(text)) return 11; // Light Sport

  // Default for Helmut's UL Seiten: Light Sport Aircraft (ultralight)
  return 11;
}

/**
 * Extract engine power from engine description.
 * E.g., "Rotax 912ULS 100 PS" → { power: "100", unit: "PS", type: "Rotax 912ULS" }
 */
function parseEnginePower(engine: string | null): {
  power: string | null;
  unit: string | null;
  type: string | null;
} {
  if (!engine) return { power: null, unit: null, type: null };

  const powerMatch = engine.match(/(\d+)\s*(PS|HP|kW)/i);
  const power = powerMatch ? powerMatch[1] : null;
  const unit = powerMatch ? powerMatch[2].toUpperCase() : null;

  // Engine type is everything before the power number
  const typeMatch = engine.match(/^(.+?)(?:\s+\d+\s*(?:PS|HP|kW))/i);
  const type = typeMatch ? typeMatch[1].trim() : engine.trim();

  return { power, unit, type };
}

/**
 * Detect seat count from description/title.
 */
function detectSeats(title: string, description: string): string | null {
  const text = `${title} ${description}`;
  const match = text.match(/(\d)\s*(?:Sitz|Sitzer|seats?|Plätze|sitzig)/i);
  if (match) return match[1];

  // Default for ULs / Microlights: 2 seats
  return "2";
}

/**
 * Upsert a parsed aircraft listing into the Supabase `aircraft_listings` table.
 */
export async function upsertAircraftListing(
  listing: ParsedAircraftListing,
  systemUserId: string
): Promise<"inserted" | "updated" | "skipped"> {
  if (!listing.year || listing.year < 1900 || listing.year > new Date().getFullYear() + 1) {
    logger.debug("Skipping listing: no valid year", { sourceId: listing.sourceId, year: listing.year });
    return "skipped";
  }
  if (!listing.description || listing.description.trim().length === 0) {
    logger.debug("Skipping listing: no description", { sourceId: listing.sourceId });
    return "skipped";
  }

  const { data: existing } = await supabase
    .from("aircraft_listings")
    .select("id, updated_at")
    .eq("source_url", listing.sourceId)
    .maybeSingle();

  // Upload images to Supabase Storage (only for new listings)
  const images = existing
    ? []
    : await uploadImages(listing.imageUrls, listing.title);

  // Translate headline + description into all 14 locales
  const translations = await translateListing(listing.title, listing.description, "de");

  // Resolve manufacturer from DB
  const manufacturer = await resolveManufacturer(listing.title);

  const record = await mapToAircraftRow(listing, systemUserId, images, translations, manufacturer);

  if (existing) {
    const { images: _skipImages, ...updateRecord } = record;
    const { error } = await supabase
      .from("aircraft_listings")
      .update({ ...updateRecord, updated_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (error) {
      logger.error("Failed to update aircraft listing", { sourceId: listing.sourceId, error: error.message });
      return "skipped";
    }
    logger.debug("Updated aircraft listing", { sourceId: listing.sourceId });
    return "updated";
  }

  const { error } = await supabase
    .from("aircraft_listings")
    .insert(record);

  if (error) {
    logger.error("Failed to insert aircraft listing", { sourceId: listing.sourceId, error: error.message });
    return "skipped";
  }
  logger.debug("Inserted aircraft listing", { sourceId: listing.sourceId });
  return "inserted";
}

async function mapToAircraftRow(
  listing: ParsedAircraftListing,
  systemUserId: string,
  uploadedImages: Array<{ url: string; alt: string }>,
  translations: TranslationResult | null,
  manufacturer: { id: number | null; name: string }
) {
  const localeFields = buildLocaleFields(listing.title, listing.description, translations);
  const engineInfo = parseEnginePower(listing.engine);
  const model = extractModel(listing.title, manufacturer.name);
  const categoryId = detectCategoryId(listing.title, listing.description);
  const seats = detectSeats(listing.title, listing.description);

  // Build the original listing URL for seller info
  // sourceId format: "pageUrl#index@date" — extract the page URL
  const originalUrl = listing.sourceUrl;

  return {
    headline: listing.title,
    model,
    year: listing.year!,
    registration: "N/A",
    serial_number: "N/A",
    location: listing.location ?? "Germany",
    price: listing.price && listing.price > 0 ? listing.price : null,
    currency: config.defaultCurrency,
    price_negotiable: !listing.price || listing.price <= 0 ? true : listing.priceNegotiable,
    description: listing.description,

    // Seller info — show source name and link to original
    contact_name: `Helmuts UL Seiten`,
    contact_email: listing.contactEmail ?? "noreply@trade.aero",
    contact_phone: listing.contactPhone ?? "",
    website: originalUrl, // Link to original listing page
    company: listing.sourceName,
    agree_to_terms: true,

    // Category (aircraft type)
    category_id: categoryId,
    condition_id: listing.year && listing.year >= new Date().getFullYear() - 2 ? 1 : 3, // Excellent if <=2yr, else Good

    // Manufacturer (FK if matched, name always set)
    manufacturer_id: manufacturer.id,

    // Engine
    engine_type_name: engineInfo.type,
    engine_power: engineInfo.power,
    engine_power_unit: engineInfo.unit ?? "PS",

    // Seats
    seats,

    // Fuel type: Rotax engines always use MOGAS
    fuel_type: listing.engine?.toLowerCase().includes("rotax") ? "MOGAS" : null,

    // All 14 locale columns
    ...localeFields,

    slug: generateSlug(listing.title),

    // Ownership & origin
    user_id: systemUserId,
    source_name: listing.sourceName,
    source_url: listing.sourceId,
    is_external: true,

    status: "active",
    country: "Germany", // Full English name, not ISO code

    // Specs
    total_time: listing.totalTime,
    max_takeoff_weight: listing.mtow?.toString() ?? null,
    max_takeoff_weight_unit: listing.mtow ? "kg" : null,
    last_annual_inspection: isValidIsoDate(listing.annualInspection) ? listing.annualInspection : null,

    // Images
    images: uploadedImages,

    auto_translate: false,
    headline_auto_translate: false,
  };
}

const LANGS = ["en", "de", "fr", "es", "it", "pl", "cs", "sv", "nl", "pt", "ru", "tr", "el", "no"] as const;

function buildLocaleFields(
  headline: string,
  description: string,
  translations: TranslationResult | null
): Record<string, string> {
  const fields: Record<string, string> = {};
  const slugSource: Record<string, { headline: string }> = {};

  for (const lang of LANGS) {
    const t = translations?.[lang];
    const h = t?.headline ?? headline;
    const d = t?.description ?? description;
    fields[`headline_${lang}`] = h;
    fields[`description_${lang}`] = d;
    slugSource[lang] = { headline: h };
  }

  const slugs = generateLocalizedSlugs(slugSource);
  for (const lang of LANGS) {
    fields[`slug_${lang}`] = slugs[lang];
  }

  return fields;
}

function isValidIsoDate(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}
