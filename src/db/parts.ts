import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import type { ParsedPartsListing } from "../types.js";

/**
 * Category name → parts_categories.id mapping.
 * These IDs must match the existing reference data in Supabase.
 * TODO: Fetch dynamically on startup instead of hardcoding.
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
 * Required NOT NULL columns: user_id, headline, category_id, manufacturer,
 *   country, contact_name, contact_email, status
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

  const record = mapToPartsRow(listing, systemUserId);

  if (existing) {
    const { error } = await supabase
      .from("parts_listings")
      .update({ ...record, updated_at: new Date().toISOString() })
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

function mapToPartsRow(listing: ParsedPartsListing, systemUserId: string) {
  return {
    // Required fields
    user_id: systemUserId,
    headline: listing.title,
    headline_de: listing.title,
    category_id: CATEGORY_MAP[listing.category] ?? CATEGORY_MAP.miscellaneous,
    manufacturer: extractManufacturer(listing.title),
    country: config.defaultCountry,
    contact_name: listing.contactName ?? "Siehe Originalanzeige",
    contact_email: listing.contactEmail ?? "noreply@trade.aero",
    contact_phone: listing.contactPhone ?? "",
    status: "active",

    // Optional fields
    description: listing.description || listing.title,
    description_de: listing.description || listing.title,
    price: listing.price,
    currency: config.defaultCurrency,
    price_on_request: listing.price === null,
    accepts_offers: listing.priceNegotiable,
    total_time: listing.totalTime,
    condition_code: "AR", // As-Removed: safe default for used parts

    // Origin tracking (Epic 3)
    source_name: listing.sourceName,
    source_url: listing.sourceId,
    is_external: true,

    // Images
    images: listing.imageUrls.map((url) => ({
      url,
      alt: listing.title,
    })),

    // Auto-translate disabled
    auto_translate: false,
    headline_auto_translate: false,

    agree_to_terms: true,
    ships_internationally: true,
  };
}

/** Best-effort manufacturer extraction from title (first word or known brand) */
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

  // Fallback: first word
  return title.split(/\s+/)[0] ?? "Unbekannt";
}
