import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug, generateLocalizedSlugs } from "../utils/slug.js";
import type { ParsedPartsListing } from "../types.js";

/**
 * Category name → parts_categories.id mapping.
 * These IDs must match the existing reference data in Supabase.
 */
const CATEGORY_MAP: Record<string, number> = {
  avionics: 1,
  engines: 2,
  rescue: 3,
  miscellaneous: 4,
};

/**
 * Upsert a parsed parts listing into the Supabase `parts_listings` table.
 *
 * Flow: check dedup → upload images → translate → insert/update
 */
export async function upsertPartsListing(
  listing: ParsedPartsListing,
  systemUserId: string
): Promise<"inserted" | "updated" | "skipped"> {
  const { data: existing } = await supabase
    .from("parts_listings")
    .select("id, updated_at")
    .eq("source_url", listing.sourceId)
    .maybeSingle();

  // Upload images to Supabase Storage (only for new listings)
  const images = existing
    ? []
    : await uploadImages(listing.imageUrls, listing.title, "parts-images");

  // Translate headline + description into all 14 locales
  const desc = listing.description || listing.title;
  const translations = await translateListing(listing.title, desc, "de");

  const record = mapToPartsRow(listing, systemUserId, images, translations);

  if (existing) {
    const { images: _skipImages, ...updateRecord } = record;
    const { error } = await supabase
      .from("parts_listings")
      .update({ ...updateRecord, updated_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (error) {
      logger.error("Failed to update parts listing", {
        sourceId: listing.sourceId,
        error: error.message,
      });
      return "skipped";
    }
    logger.debug("Updated parts listing", { sourceId: listing.sourceId });
    return "updated";
  }

  const { error } = await supabase
    .from("parts_listings")
    .insert(record);

  if (error) {
    logger.error("Failed to insert parts listing", {
      sourceId: listing.sourceId,
      error: error.message,
    });
    return "skipped";
  }
  logger.debug("Inserted parts listing", { sourceId: listing.sourceId });
  return "inserted";
}

function mapToPartsRow(
  listing: ParsedPartsListing,
  systemUserId: string,
  uploadedImages: Array<{ url: string; alt: string }>,
  translations: TranslationResult | null
) {
  const desc = listing.description || listing.title;
  const localeFields = buildLocaleFields(listing.title, desc, translations);

  return {
    // Required fields
    user_id: systemUserId,
    headline: listing.title,
    category_id: CATEGORY_MAP[listing.category] ?? CATEGORY_MAP.miscellaneous,
    manufacturer: extractManufacturer(listing.title),
    country: config.defaultCountry,
    contact_name: listing.contactName ?? "Siehe Originalanzeige",
    contact_email: listing.contactEmail ?? "noreply@trade.aero",
    contact_phone: listing.contactPhone ?? "",
    status: "active",

    // All 14 locale columns
    ...localeFields,

    // Base fields
    description: desc,
    slug: generateSlug(listing.title),

    // Optional fields
    price: listing.price,
    currency: config.defaultCurrency,
    price_on_request: listing.price === null,
    accepts_offers: listing.priceNegotiable,
    total_time: listing.totalTime,
    condition_code: "AR",

    // Origin tracking (Epic 3)
    source_name: listing.sourceName,
    source_url: listing.sourceId,
    is_external: true,

    // Images — uploaded to Supabase Storage
    images: uploadedImages,

    // Translation handled by crawler
    auto_translate: false,
    headline_auto_translate: false,

    agree_to_terms: true,
    ships_internationally: true,
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

/** Best-effort manufacturer extraction from title */
function extractManufacturer(title: string): string {
  const knownBrands = [
    "Rotax", "BRP", "Garmin", "Becker", "Junkers", "Trig", "Funkwerk",
    "Bose", "David Clark", "Sennheiser", "Dynon", "MGL", "FLARM",
    "Junkers Profly", "Fresh Breeze", "Parajet", "Nirvana", "Vittorazi",
    "Polini", "Cors-Air", "HKS", "Simonini", "Bailey", "Hirth",
  ];

  const titleLower = title.toLowerCase();
  for (const brand of knownBrands) {
    if (titleLower.includes(brand.toLowerCase())) {
      return brand;
    }
  }

  return title.split(/\s+/)[0] ?? "Unbekannt";
}
