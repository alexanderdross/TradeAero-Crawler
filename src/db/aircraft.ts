import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug, generateLocalizedSlugs } from "../utils/slug.js";
import type { ParsedAircraftListing } from "../types.js";

/**
 * Upsert a parsed aircraft listing into the Supabase `aircraft_listings` table.
 *
 * Flow: validate → check dedup → upload images → translate → insert/update
 */
export async function upsertAircraftListing(
  listing: ParsedAircraftListing,
  systemUserId: string
): Promise<"inserted" | "updated" | "skipped"> {
  // Validate required fields that have DB CHECK constraints
  if (!listing.year || listing.year < 1900 || listing.year > new Date().getFullYear() + 1) {
    logger.debug("Skipping listing: no valid year", { sourceId: listing.sourceId, year: listing.year });
    return "skipped";
  }
  if (!listing.description || listing.description.trim().length === 0) {
    logger.debug("Skipping listing: no description", { sourceId: listing.sourceId });
    return "skipped";
  }

  // Check if listing already exists by source_url + source_id
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

  const record = mapToAircraftRow(listing, systemUserId, images, translations);

  if (existing) {
    // Update existing record (keep existing images)
    const { images: _skipImages, ...updateRecord } = record;
    const { error } = await supabase
      .from("aircraft_listings")
      .update({ ...updateRecord, updated_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (error) {
      logger.error("Failed to update aircraft listing", {
        sourceId: listing.sourceId,
        error: error.message,
      });
      return "skipped";
    }
    logger.debug("Updated aircraft listing", { sourceId: listing.sourceId });
    return "updated";
  }

  // Insert new record
  const { error } = await supabase
    .from("aircraft_listings")
    .insert(record);

  if (error) {
    logger.error("Failed to insert aircraft listing", {
      sourceId: listing.sourceId,
      error: error.message,
    });
    return "skipped";
  }
  logger.debug("Inserted aircraft listing", { sourceId: listing.sourceId });
  return "inserted";
}

function mapToAircraftRow(
  listing: ParsedAircraftListing,
  systemUserId: string,
  uploadedImages: Array<{ url: string; alt: string }>,
  translations: TranslationResult | null
) {
  // Build locale-specific headline, description, and slug columns
  const localeFields = buildLocaleFields(listing.title, listing.description, translations);

  return {
    // Required fields (validated before this point)
    headline: listing.title,
    model: listing.title,
    year: listing.year!,
    registration: "N/A",
    serial_number: "N/A",
    location: listing.location ?? "Deutschland",
    price: listing.price && listing.price > 0 ? listing.price : null,
    currency: config.defaultCurrency,
    price_negotiable: !listing.price || listing.price <= 0 ? true : listing.priceNegotiable,
    description: listing.description,
    contact_name: listing.contactName ?? "Siehe Originalanzeige",
    contact_email: listing.contactEmail ?? "noreply@trade.aero",
    contact_phone: listing.contactPhone ?? "",
    agree_to_terms: true,

    // All 14 locale columns for headline, description, and slug
    ...localeFields,

    // Base slug
    slug: generateSlug(listing.title),

    // Ownership & origin (Epic 3)
    user_id: systemUserId,
    source_name: listing.sourceName,
    source_url: listing.sourceId,
    is_external: true,

    // Status
    status: "active",
    country: config.defaultCountry,

    // Specs (when available)
    total_time: listing.totalTime,
    max_takeoff_weight: listing.mtow?.toString() ?? null,
    max_takeoff_weight_unit: listing.mtow ? "kg" : null,
    engine_type_name: listing.engine,
    last_annual_inspection: isValidIsoDate(listing.annualInspection) ? listing.annualInspection : null,

    // Images as JSONB array [{url, alt}] — uploaded to Supabase Storage
    images: uploadedImages,

    // Translation was handled by crawler, not by frontend auto-translate
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

  // Generate slugs from translations (or fallback to German for all)
  const slugSource: Record<string, { headline: string }> = {};

  for (const lang of LANGS) {
    const t = translations?.[lang];
    const h = t?.headline ?? headline;
    const d = t?.description ?? description;

    fields[`headline_${lang}`] = h;
    fields[`description_${lang}`] = d;
    slugSource[lang] = { headline: h };
  }

  // Generate localized slugs
  const slugs = generateLocalizedSlugs(slugSource);
  for (const lang of LANGS) {
    fields[`slug_${lang}`] = slugs[lang];
  }

  return fields;
}

/** Check if a string is a valid ISO date (YYYY-MM-DD) */
function isValidIsoDate(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}
