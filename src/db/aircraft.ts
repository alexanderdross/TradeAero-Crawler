import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import type { ParsedAircraftListing } from "../types.js";

/**
 * Upsert a parsed aircraft listing into the Supabase `aircraft_listings` table.
 *
 * Schema mapping:
 * - Uses `source_url` column for deduplication (Epic 4.1)
 * - Sets `source_name` and `is_external` for origin tracking (Epic 3)
 * - Populates required fields with scraped data or safe defaults
 * - Sets status = 'active' for display on /aircraft/
 * - Uses a dedicated system user_id for scraped listings (Epic 3.3)
 *
 * Required NOT NULL columns: headline, model, year, registration, serial_number,
 *   location, price, currency, description, contact_name, contact_email, contact_phone
 */
export async function upsertAircraftListing(
  listing: ParsedAircraftListing,
  systemUserId: string
): Promise<"inserted" | "updated" | "skipped"> {
  // Validate required fields that have DB CHECK constraints
  if (!listing.price || listing.price <= 0) {
    logger.debug("Skipping listing: no valid price", { sourceId: listing.sourceId });
    return "skipped";
  }
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
    ? [] // Skip re-uploading for updates
    : await uploadImages(listing.imageUrls, listing.title);

  const record = mapToAircraftRow(listing, systemUserId, images);

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
  uploadedImages: Array<{ url: string; alt: string }>
) {
  return {
    // Required fields (validated before this point)
    headline: listing.title,
    headline_de: listing.title,
    model: listing.title,
    year: listing.year!,
    registration: "N/A",
    serial_number: "N/A",
    location: listing.location ?? "Deutschland",
    price: listing.price!,
    currency: config.defaultCurrency,
    price_negotiable: listing.priceNegotiable,
    description: listing.description,
    description_de: listing.description,
    contact_name: listing.contactName ?? "Siehe Originalanzeige",
    contact_email: listing.contactEmail ?? "noreply@trade.aero",
    contact_phone: listing.contactPhone ?? "",
    agree_to_terms: true,

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
    // Only set if it's a valid ISO date (YYYY-MM-DD)
    last_annual_inspection: isValidIsoDate(listing.annualInspection) ? listing.annualInspection : null,

    // Images as JSONB array [{url, alt}] — uploaded to Supabase Storage
    images: uploadedImages,

    // Auto-translate disabled for scraped content (already in German)
    auto_translate: false,
    headline_auto_translate: false,
  };
}

/** Check if a string is a valid ISO date (YYYY-MM-DD) */
function isValidIsoDate(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}
