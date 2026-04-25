import { contentHash, slugify } from "./event-dedup.js";
import { supabase } from "./client.js";
import { verifyEventsDedupIndex } from "./events-startup-checks.js";
import { getEventCategoryIdByCode } from "./categories.js";
import { validateEvent } from "./event-validation.js";
import { computeCanonicalKey } from "./event-canonical-key.js";
import { compareSourcePriority } from "./event-source-priority.js";
import { translateListing } from "../utils/translate.js";
import { generateLocalizedSlugs } from "../utils/slug.js";
import { sanitizeForDb } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import { geocode } from "../utils/geocode.js";
import type { ParsedEvent } from "../types.js";
import { synthesizeEventDescription } from "../parsers/vereinsflieger.js";

// IMPORTANT: this 14-element list MUST stay aligned with `APP_LOCALES`
// in `tradeaero-refactor/src/i18n/locales.ts` and with the per-locale
// `title_<lang>` / `description_<lang>` / `slug_<lang>` columns on
// `aviation_events`. The crawler is a separate npm package so we
// can't import the constant directly; the runtime sentinel below
// guards against drift on first upsert.
const LANGS = [
  "en", "de", "fr", "es", "it", "pl", "cs", "sv", "nl", "pt", "ru", "tr", "el", "no",
] as const;
type Lang = (typeof LANGS)[number];

/** Hand-pinned by the most recent refactor-side audit. Bump this when
 *  intentionally adding a new locale on both sides; the sentinel below
 *  catches accidental drift (e.g. a copy-paste deletion). */
const EXPECTED_LANG_COUNT = 14;
const EXPECTED_FIRST_LANG = "en";
const EXPECTED_LAST_LANG = "no";

if (
  LANGS.length !== EXPECTED_LANG_COUNT ||
  LANGS[0] !== EXPECTED_FIRST_LANG ||
  LANGS[LANGS.length - 1] !== EXPECTED_LAST_LANG
) {
  // Throw at module-load: a desync between the crawler's LANGS and the
  // refactor side's APP_LOCALES would silently produce events with
  // missing locale columns. Better to fail the run than to publish
  // half-translated rows.
  throw new Error(
    `Crawler LANGS desynced from refactor APP_LOCALES — expected ` +
      `${EXPECTED_LANG_COUNT} locales starting with "${EXPECTED_FIRST_LANG}" ` +
      `and ending with "${EXPECTED_LAST_LANG}", got [${LANGS.join(", ")}]. ` +
      `Update both src/db/events.ts and tradeaero-refactor/src/i18n/locales.ts together.`,
  );
}

// `UpsertOutcome` / `UpsertSkipReason` live in `events-types.ts` so
// pure helpers can use them without importing the Supabase client.
export type { UpsertOutcome, UpsertSkipReason } from "./events-types.js";
import type { UpsertOutcome } from "./events-types.js";

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

// `contentHash` + `slugify` live in `./event-dedup.ts` so the dedup
// helpers are unit-testable without triggering this module's Supabase
// client initialisation. Re-exported here for any downstream consumer
// that already imports them from `./events`.
export { contentHash, slugify };

/**
 * Upsert a single event row. Dedup is enforced by the partial UNIQUE index
 * on (external_source, source_url). On a match, we re-use the stored
 * translations unless the hash of (title + description) has changed.
 */
export async function upsertEvent(event: ParsedEvent): Promise<UpsertOutcome> {
  // First call per process: surface a clear warning if the dedup
  // index migration hasn't run. Memoised inside the helper.
  await verifyEventsDedupIndex();

  // Sanity-validate the parsed row before doing anything expensive
  // (translator + geocoder both have non-trivial cost). Failures are
  // logged with a stable reason tag so the dropped-rate metric in the
  // admin dashboard can chart them by cause.
  const validation = validateEvent(event);
  if (!validation.ok) {
    logger.warn("Dropping invalid event", {
      sourceName: event.sourceName,
      sourceUrl: event.sourceUrl,
      title: event.title,
      reason: validation.reason,
    });
    return { kind: "skipped", reason: validation.reason };
  }

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

  // Cross-source dedup: collapse the same fly-in / airshow when it
  // appears across an organiser feed AND a magazine reprint AND a
  // forum repost. See EVENT_SOURCES_TIER2_AGGREGATORS.md §4.
  //
  // Skipped when the parser didn't supply enough anchoring data
  // (no ICAO + no city + no venue) so we never collapse two genuinely
  // distinct events under the same hash.
  const canonicalKey = computeCanonicalKey(event);
  if (canonicalKey) {
    const { data: crossSourceRow, error: crossErr } = await supabase
      .from("aviation_events")
      .select("id, external_source")
      .eq("canonical_key", canonicalKey)
      .neq("external_source", event.sourceName)
      .maybeSingle();
    if (crossErr) {
      logger.debug("canonical_key lookup failed (column may not exist yet)", {
        sourceUrl: event.sourceUrl,
        error: crossErr.message,
      });
    } else if (crossSourceRow) {
      const cmp = compareSourcePriority(
        event.sourceName,
        crossSourceRow.external_source ?? "",
      );
      if (cmp === "lower" || cmp === "equal") {
        logger.debug("Suppressing lower-priority cross-source duplicate", {
          sourceName: event.sourceName,
          sourceUrl: event.sourceUrl,
          existingSource: crossSourceRow.external_source,
          canonicalKey,
        });
        return { kind: "skipped", reason: "lower_priority_duplicate" };
      }
      // New source outranks existing → supersede the lower-priority row
      // by deleting it. The fresh INSERT below then carries the same
      // canonical_key as the canonical record going forward.
      const { error: delErr } = await supabase
        .from("aviation_events")
        .delete()
        .eq("id", crossSourceRow.id);
      if (delErr) {
        logger.warn("Failed to supersede lower-priority duplicate", {
          existingId: crossSourceRow.id,
          error: delErr.message,
        });
      } else {
        logger.info("Superseded lower-priority cross-source duplicate", {
          existingSource: crossSourceRow.external_source,
          newSource: event.sourceName,
          canonicalKey,
        });
      }
    }
  }

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
    canonical_key: canonicalKey,
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
      return { kind: "skipped", reason: "unchanged" };
    }
    const { error: updateError } = await supabase
      .from("aviation_events")
      .update({ ...basePayload, ...(localeFields ?? {}) })
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`UPDATE aviation_events failed: ${updateError.message}`);
    }
    return { kind: "updated" };
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
      return { kind: "skipped", reason: "concurrent_insert" };
    }
    throw new Error(`INSERT aviation_events failed: ${insertError.message}`);
  }

  return { kind: "inserted" };
}

