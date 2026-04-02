import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug } from "../utils/slug.js";
import { LANGS, buildLocaleFields } from "./locale-helpers.js";
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
  const { data: existing, error: lookupError } = await supabase
    .from("parts_listings")
    .select("id, updated_at, images")
    .eq("source_url", listing.sourceId)
    .maybeSingle();

  if (lookupError) {
    logger.error("Dedup lookup failed", { sourceId: listing.sourceId, error: lookupError.message });
    return "skipped";
  }

  if (existing) {
    // ── UPDATE PATH (fast: skip translation, re-upload external images) ──
    const existingImages = (existing.images as Array<{ url?: string }>) ?? [];
    const hasExternalImages = existingImages.length > 0 && existingImages.some(
      (img) => img.url && !img.url.includes("supabase.co")
    );
    let freshImages: Array<{ url: string; alt_text: string }> = [];
    if (hasExternalImages && listing.imageUrls.length > 0) {
      freshImages = await uploadImages(listing.imageUrls, listing.title, "parts-images");
    }

    const record = mapToPartsRow(listing, systemUserId, freshImages, null);

    // Strip locale fields to preserve existing translations
    const updateFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (/^(headline|description|slug|remaining_life)_(en|de|fr|es|it|pl|cs|sv|nl|pt|ru|tr|el|no)$/.test(key)) continue;
      if (key === "images" && freshImages.length === 0) continue;
      updateFields[key] = value;
    }

    const { error } = await supabase
      .from("parts_listings")
      .update({ ...updateFields, updated_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (error) {
      logger.error("Failed to update parts listing", { sourceId: listing.sourceId, error: error.message });
      return "skipped";
    }
    logger.debug("Updated parts listing", { sourceId: listing.sourceId });
    return "updated";
  }

  // ── INSERT PATH (full pipeline) ──

  // Ensure description passes DB constraint (description_check: 10+ chars, non-empty)
  listing.description = (listing.description ?? "").replace(/<[^>]*>/g, "").trim();
  if (!listing.description || listing.description.length < 10) {
    listing.description = listing.title;
  }
  if (!listing.description || listing.description.trim().length < 10) {
    listing.description = `${listing.title} — parts listing`.trim();
    if (listing.description.length < 10) {
      logger.debug("Skipping parts listing: no valid description or title", { sourceId: listing.sourceId });
      return "skipped";
    }
  }
  const cleanDesc = listing.description;

  const images = await uploadImages(listing.imageUrls, listing.title, "parts-images");
  const translations = await translateListing(listing.title, cleanDesc, "de");

  const record = mapToPartsRow(listing, systemUserId, images, translations);

  const { error } = await supabase
    .from("parts_listings")
    .insert(record);

  if (error) {
    const level = error.message?.includes("check constraint") ? "warn" : "error";
    logger[level]("Failed to insert parts listing", {
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
  uploadedImages: Array<{ url: string; alt_text: string }>,
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
    // parts_listings constraint only allows: active, paused, expired, deleted
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

    // Images — enriched with per-locale alt text
    images: enrichImagesWithLocalizedAlt(uploadedImages, listing.title, translations),

    // Translation handled by crawler
    auto_translate: false,
    headline_auto_translate: false,

    agree_to_terms: true,
    ships_internationally: true,
  };
}


/** Enrich images with per-locale alt text from translations */
function enrichImagesWithLocalizedAlt(
  images: Array<{ url: string; alt_text: string }>,
  defaultAlt: string,
  translations: TranslationResult | null
): Array<Record<string, unknown>> {
  return images.map((img, idx) => {
    const enriched: Record<string, unknown> = {
      url: img.url,
      alt_text: img.alt_text || defaultAlt,
      auto_translate: false,
      sort_order: idx,
    };
    for (const lang of LANGS) {
      const t = translations?.[lang];
      enriched[`alt_text_${lang}`] = t?.headline
        ? `${t.headline} - Image ${idx + 1}`
        : `${defaultAlt} - Image ${idx + 1}`;
    }
    return enriched;
  });
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
