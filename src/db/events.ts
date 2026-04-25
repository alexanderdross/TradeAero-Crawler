import { createHash } from "node:crypto";
import { supabase } from "./client.js";
import { getEventCategoryIdByCode } from "./categories.js";
import { translateListing } from "../utils/translate.js";
import { generateLocalizedSlugs } from "../utils/slug.js";
import { sanitizeForDb } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import { geocode } from "../utils/geocode.js";
import type { ParsedEvent } from "../types.js";
import { synthesizeEventDescription } from "../parsers/vereinsflieger.js";

const LANGS = [
  "en", "de", "fr", "es", "it", "pl", "cs", "sv", "nl", "pt", "ru", "tr", "el", "no",
] as const;
type Lang = (typeof LANGS)[number];

type UpsertResult = "inserted" | "updated" | "skipped";

/**
 * Build title_{lang}, description_{lang}, slug_{lang} fields for the
 * locales actually present in `translations`. Locales missing from the
 * translator response are left unpopulated (the caller will pass them as
 * NULL to Supabase) so bilingual-minimum runs don't silently fill all 14
 * columns with the German source text.
 *
 * Mirrors db/locale-helpers#buildLocaleFields but emits `title_*`
 * instead of `headline_*` to match the aviation_events schema.
 */
function buildEventLocaleFields(
  title: string,
  description: string,
  translations: Awaited<ReturnType<typeof translateListing>>,
  sourceLocale: string = "de",
): Record<string, string> {
  const out: Record<string, string> = {};
  const slugSource: Record<string, { headline: string }> = {};

  for (const lang of LANGS) {
    const t = translations?.[lang as Lang];
    if (!t?.headline || !t?.description) continue;
    out[`title_${lang}`] = sanitizeForDb(t.headline);
    out[`description_${lang}`] = sanitizeForDb(t.description);
    slugSource[lang] = { headline: t.headline };
  }

  const slugs = generateLocalizedSlugs(slugSource);
  for (const lang of Object.keys(slugSource)) {
    const s = slugs[lang];
    if (s) out[`slug_${lang}`] = s;
  }

  // Always set the source-locale columns so the row is recoverable even
  // if the translator returned no usable response (missing ANTHROPIC_API_KEY,
  // rate limit, transient error, etc).
  const srcKey = `title_${sourceLocale}`;
  const srcDescKey = `description_${sourceLocale}`;
  if (!out[srcKey] && title) out[srcKey] = sanitizeForDb(title);
  if (!out[srcDescKey] && description)
    out[srcDescKey] = sanitizeForDb(description);

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
  // Use the parser-supplied description when present (ICS feeds carry one);
  // otherwise synthesize from the available metadata (Vereinsflieger).
  const description =
    event.description && event.description.trim().length >= 10
      ? event.description
      : synthesizeEventDescription(event);
  const title = event.title;
  // Source language drives the bilingual-min translator. Defaults to "de"
  // for legacy compatibility with the Vereinsflieger crawler — every newer
  // crawler should set sourceLocale explicitly on the ParsedEvent.
  const sourceLocale = event.sourceLocale ?? "de";

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

  // Geocode missing coords. Only runs on INSERT (no `existing` row yet) and
  // when the parser didn't already populate lat/lng — Nominatim is rate-
  // limited (1 req/s) so we minimise calls. Failures are non-fatal: the
  // row inserts without coords and the map view falls back to ICAO/city.
  let latitude = event.latitude ?? null;
  let longitude = event.longitude ?? null;
  if (!existing && (latitude == null || longitude == null)) {
    const hit = await geocode({
      venue: event.venueName,
      city: event.city,
      country: event.country,
      icao: event.icaoCode,
    });
    if (hit) {
      latitude = hit.lat;
      longitude = hit.lon;
    }
  }

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
    latitude,
    longitude,
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

  // Skip translation work if the content is unchanged.
  //
  // Bilingual-minimum policy (per AVIATION_EVENTS_JOBS_CONCEPT.md): crawled
  // events are stored in the source locale (`de` for vereinsflieger) plus
  // English only. The other 12 locale columns stay NULL so downstream UI
  // fallback (title_xx ?? title_en ?? title_de) shows users the translated
  // English copy instead of silently duplicating German into every cell.
  let localeFields: Record<string, string> | null = null;
  if (!existing || existingHash !== newHash) {
    // Bilingual-min targets: just English when source isn't already
    // English; an empty target list otherwise (translator returns the
    // source as-is for the en-source case).
    const targetLangs = sourceLocale === "en" ? [] : (["en"] as const);
    const translations = await translateListing(
      title,
      description,
      sourceLocale as "en" | "de" | "fr" | "es" | "it" | "pl" | "cs" | "sv" | "nl" | "pt" | "ru" | "tr" | "el" | "no",
      { targetLangs: targetLangs as readonly Lang[] },
    );
    localeFields = buildEventLocaleFields(
      title,
      description,
      translations,
      sourceLocale,
    );
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
