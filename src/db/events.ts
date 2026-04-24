import { createHash } from "node:crypto";
import { supabase } from "./client.js";
import { getEventCategoryIdByCode } from "./categories.js";
import { translateListing } from "../utils/translate.js";
import { generateLocalizedSlugs } from "../utils/slug.js";
import { sanitizeForDb } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import type { ParsedEvent } from "../types.js";
import { synthesizeEventDescription } from "../parsers/vereinsflieger.js";

const LANGS = [
  "en", "de", "fr", "es", "it", "pl", "cs", "sv", "nl", "pt", "ru", "tr", "el", "no",
] as const;
type Lang = (typeof LANGS)[number];

type UpsertResult = "inserted" | "updated" | "skipped";

/**
 * Build title_{lang}, description_{lang}, slug_{lang} fields for all 14
 * locales. Mirrors db/locale-helpers#buildLocaleFields but emits `title_*`
 * instead of `headline_*` to match the aviation_events schema.
 */
function buildEventLocaleFields(
  title: string,
  description: string,
  translations: Awaited<ReturnType<typeof translateListing>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const slugSource: Record<string, { headline: string }> = {};

  for (const lang of LANGS) {
    const t = translations?.[lang as Lang];
    const localizedTitle = t?.headline ?? title;
    const localizedDesc = t?.description ?? description;
    out[`title_${lang}`] = sanitizeForDb(localizedTitle);
    out[`description_${lang}`] = sanitizeForDb(localizedDesc);
    slugSource[lang] = { headline: localizedTitle };
  }

  const slugs = generateLocalizedSlugs(slugSource);
  for (const lang of LANGS) {
    out[`slug_${lang}`] = slugs[lang] ?? "";
  }

  return out;
}

/** Stable hash of the translatable content — drives re-translate decisions. */
function contentHash(title: string, description: string): string {
  return createHash("sha1").update(`${title} ${description}`).digest("hex");
}

/**
 * Upsert a single event row. Dedup is enforced by the partial UNIQUE index
 * on (external_source, source_url). On a match, we re-use the stored
 * translations unless the hash of (title + description) has changed.
 */
export async function upsertEvent(event: ParsedEvent): Promise<UpsertResult> {
  const description = synthesizeEventDescription(event);
  const title = event.title;

  // Look up existing row to decide insert vs update, and to reuse translations
  const { data: existing, error: selectError } = await supabase
    .from("aviation_events")
    .select("id, title, description")
    .eq("external_source", event.sourceName)
    .eq("source_url", event.sourceUrl)
    .maybeSingle();

  if (selectError) {
    logger.warn("Failed to SELECT existing event — attempting INSERT anyway", {
      sourceUrl: event.sourceUrl,
      error: selectError.message,
    });
  }

  const categoryId = await getEventCategoryIdByCode(event.categoryCode);

  // Compose the base payload (static columns shared by insert + update)
  const baseSlug = slugify(title);
  const basePayload: Record<string, unknown> = {
    status: "active",
    moderation_status: "approved",
    category_id: categoryId,
    title: sanitizeForDb(title),
    description: sanitizeForDb(description),
    title_auto_translate: true,
    auto_translate: true,
    start_date: event.startDate,
    end_date: event.endDate,
    timezone: event.timezone,
    is_recurring: false,
    country: event.country,
    city: event.city ?? event.venueName,
    venue_name: event.venueName,
    icao_code: event.icaoCode,
    organizer_name: event.organizerName,
    price: 0,
    currency: "EUR",
    is_free: true,
    requires_registration: false,
    images: [],
    external_source: event.sourceName,
    source_url: event.sourceUrl,
    slug: baseSlug,
  };

  const newHash = contentHash(title, description);
  const existingHash = existing
    ? contentHash(existing.title ?? "", existing.description ?? "")
    : null;

  // Skip translation work if the content is unchanged
  let localeFields: Record<string, string> | null = null;
  if (!existing || existingHash !== newHash) {
    const translations = await translateListing(title, description, "de");
    localeFields = buildEventLocaleFields(title, description, translations);
  }

  if (existing) {
    if (existingHash === newHash) {
      logger.debug("Event unchanged — skip re-translate", { sourceUrl: event.sourceUrl });
      return "skipped";
    }
    const { error: updateError } = await supabase
      .from("aviation_events")
      .update({ ...basePayload, ...(localeFields ?? {}) })
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`UPDATE aviation_events failed: ${updateError.message}`);
    }
    return "updated";
  }

  const insertPayload = {
    user_id: null,
    ...basePayload,
    ...(localeFields ?? {}),
  };

  const { error: insertError } = await supabase
    .from("aviation_events")
    .insert(insertPayload);

  if (insertError) {
    // Race-condition guard: if the unique index fired between our SELECT and
    // INSERT, treat that as an "update" signal from the crawler's perspective.
    if (insertError.code === "23505") {
      logger.debug("Concurrent insert — treating as skipped", { sourceUrl: event.sourceUrl });
      return "skipped";
    }
    throw new Error(`INSERT aviation_events failed: ${insertError.message}`);
  }

  return "inserted";
}

/**
 * Base slug for the `slug` column — the schema requires UNIQUE NOT NULL so
 * we append the sha1 fragment already embedded in source_url to guarantee
 * uniqueness without an extra DB round-trip.
 */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const suffix = createHash("sha1").update(title).digest("hex").slice(0, 8);
  return `${base || "event"}-${suffix}`;
}
