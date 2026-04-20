import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug } from "../utils/slug.js";
import { LANGS, buildLocaleFields } from "./locale-helpers.js";
import { enqueueInviteCandidate } from "./invite-candidates.js";
import type { ParsedPartsListing } from "../types.js";

/**
 * Category name → parts_categories.id mapping.
 * These IDs must match the existing reference data in Supabase.
 */
const CATEGORY_MAP: Record<string, number> = {
  avionics: 1,
  engines: 2,
  propellers: 3,
  instruments: 6,
  rescue: 5,
  miscellaneous: 5,
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
    .select("id, updated_at, images, is_external, claimed_at")
    .eq("source_url", listing.sourceId)
    .maybeSingle();

  if (lookupError) {
    logger.error("Dedup lookup failed", { sourceId: listing.sourceId, error: lookupError.message });
    return "skipped";
  }

  // Skip-on-claim guard (§8c of COLD_EMAIL_CLAIM_CONCEPT.md). Mirrors the
  // aircraft-side check in src/db/aircraft.ts. Once a parts listing has
  // been claimed — by either /claim/[token] or /claim/external/ — the
  // row belongs to a real user and must not be overwritten by a
  // subsequent crawl.
  if (existing && (existing.is_external === false || existing.claimed_at)) {
    logger.info(
      `Skipping claimed parts listing (source_url=${listing.sourceId}, is_external=${existing.is_external}, claimed_at=${existing.claimed_at ?? "null"})`,
    );
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

    // Strip locale fields and slug to preserve existing translations and trigger-generated slugs
    const updateFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (/^(headline|description|slug|remaining_life)_(en|de|fr|es|it|pl|cs|sv|nl|pt|ru|tr|el|no)$/.test(key)) continue;
      if (key === "slug") continue; // Preserve trigger-generated slug (headline-{listing_number})
      if (key === "images" && freshImages.length === 0) continue;
      // Never overwrite the claim audit flags on existing rows.
      if (key === "was_external" || key === "claimed_at" || key === "claimed_from_source") continue;
      updateFields[key] = value;
    }

    // H2: atomic skip-on-claim guard. Redundant with the earlier dedup
    // SELECT (which already returns "skipped" for claimed rows), but
    // closes the race window between SELECT and UPDATE if a concurrent
    // approval flips the row in the meantime.
    const { error, data: updatedRows } = await supabase
      .from("parts_listings")
      .update({ ...updateFields, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("is_external", true)
      .is("claimed_at", null)
      .select("id");

    if (error) {
      logger.error("Failed to update parts listing", { sourceId: listing.sourceId, error: error.message });
      return "skipped";
    }
    if (!updatedRows || updatedRows.length === 0) {
      logger.info("Skipped claimed parts listing (raced with claim flow)", {
        sourceId: listing.sourceId,
      });
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

  const { data: inserted, error } = await supabase
    .from("parts_listings")
    .insert(record)
    .select("id, slug, listing_number")
    .single();

  if (error) {
    const msg = error.message ?? "";
    // Benign: DB check constraints and the Task-3 unique-source_url index
    // firing on a concurrent crawl. Skip the listing, don't page anyone.
    const benign =
      msg.includes("check constraint") ||
      msg.includes("duplicate key") ||
      msg.includes("source_url_unique");
    const level = benign ? "warn" : "error";
    logger[level]("Failed to insert parts listing", {
      sourceId: listing.sourceId,
      error: error.message,
    });
    return "skipped";
  }

  // Generate proper localized slugs using the DB-assigned listing_number
  // (mirrors aircraft.ts — without listing_number suffix, duplicate titles share the same slug_en
  //  causing maybeSingle() to fail on the detail page)
  const listingNum = (inserted as { listing_number?: number | null }).listing_number ?? null;
  if (listingNum && translations) {
    const slugUpdate: Record<string, string> = {};
    // slug_en = trigger-generated base slug (already has listing_number suffix)
    if ((inserted as { slug?: string | null }).slug) {
      slugUpdate.slug_en = (inserted as { slug: string }).slug;
    }
    for (const lang of LANGS) {
      if (lang === "en") continue;
      const headline = (record as Record<string, unknown>)[`headline_${lang}`];
      if (headline && typeof headline === "string" && headline.trim()) {
        slugUpdate[`slug_${lang}`] = generateSlug(headline, listingNum);
      }
    }
    if (Object.keys(slugUpdate).length > 0) {
      await supabase.from("parts_listings").update(slugUpdate).eq("id", (inserted as { id: string }).id);
    }
  }

  // Queue claim-invite candidate for parts sources with sendColdEmailInvite=true.
  // Mirrors the aircraft.ts hook. Never blocks or fails the crawl.
  await enqueueInviteCandidate({
    listingId: (inserted as { id: string }).id,
    listingType: "parts",
    contactEmail: listing.contactEmail,
    sourceName: listing.sourceName,
  });

  logger.debug("Inserted parts listing", { sourceId: listing.sourceId, listingNumber: listingNum });
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
    // Audit flag that survives the claim flip. Set on every crawler INSERT
    // so the claim-% denominator counts every ever-external listing, not
    // just already-claimed ones (mirrors src/db/aircraft.ts).
    was_external: true,

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
