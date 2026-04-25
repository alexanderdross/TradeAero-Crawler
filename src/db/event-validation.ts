import type { ParsedEvent } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pre-upsert sanity validation for ParsedEvent rows.
//
// Catches malformed events before they hit the translator (~1k tokens
// per row × 14 locales) and the geocoder (rate-limited 1 req/s). One
// bad parser shouldn't burn an hour of crawler runtime or pollute
// `aviation_events` with rows that will fail downstream rendering.
//
// Each rule corresponds to a real failure mode observed during the
// initial Vereinsflieger / ICS roll-out:
//
//   - Title-less events from feeds with empty SUMMARY lines.
//   - DTSTART > DTEND (parser swap or buggy local-timezone conversion
//     across DST boundaries).
//   - 8-day "fly-in" that's actually 800 days because a feed exporter
//     mixed up units.
//   - Past events that re-crawl forever because the source never
//     drops them.
//   - Junk ICAOs ("AA", "?, EDXX") that break the airport lookup.
//
// Return shape is a discriminated union so callers `switch` on it
// rather than truthiness — keeps the dropped-row metric labelled with
// the precise reason.
// ─────────────────────────────────────────────────────────────────────────────

export type EventValidation =
  | { ok: true }
  | { ok: false; reason: EventValidationReason };

/** Stable tags for the dropped-row metric and admin dashboard charts. */
export type EventValidationReason =
  | "missing_title"
  | "title_too_short"
  | "missing_source_url"
  | "missing_category"
  | "missing_country"
  | "invalid_start_date"
  | "invalid_end_date"
  | "end_before_start"
  | "duration_exceeds_max"
  | "ended_too_long_ago"
  | "starts_too_far_in_future"
  | "invalid_icao"
  | "invalid_coordinates";

/** Minimum trimmed title length. Two-character titles ("AT", "Q?") are
 *  invariably parser noise; three-character titles like "EAA" are valid
 *  organisation labels. */
const MIN_TITLE_LENGTH = 3;

/** Hard cap on event duration. Trade fairs (AERO Friedrichshafen) run
 *  4 days, fly-in seasons run a couple weeks, multi-event seminar
 *  series might span a month. >90 days is invariably a parse error. */
const MAX_DURATION_DAYS = 90;

/** Drop events whose end date is more than this many days in the past.
 *  Generous (90 days) so legitimate post-event re-crawls aren't dropped
 *  on subsequent runs while the source still publishes them — but
 *  stops year-old events from sitting in `aviation_events`. */
const PAST_TOLERANCE_DAYS = 90;

/** Drop events whose start date is more than this many years in the
 *  future. EBACE/AERO sometimes publish 2-year-out save-the-date rows
 *  legitimately; 5 years is a comfortable ceiling. */
const FUTURE_TOLERANCE_YEARS = 5;

/**
 * Validate a parsed event before any expensive downstream work.
 *
 * `now` is injected for testability — production callers omit it and
 * let the helper read `Date.now()` directly.
 */
export function validateEvent(
  event: ParsedEvent,
  now: Date = new Date(),
): EventValidation {
  // 1. Title — required, non-trivial.
  const title = event.title?.trim() ?? "";
  if (!title) return { ok: false, reason: "missing_title" };
  if (title.length < MIN_TITLE_LENGTH)
    return { ok: false, reason: "title_too_short" };

  // 2. Source URL + category — required for upsert path.
  if (!event.sourceUrl?.trim()) {
    return { ok: false, reason: "missing_source_url" };
  }
  if (!event.categoryCode?.trim()) {
    return { ok: false, reason: "missing_category" };
  }
  if (!event.country?.trim()) {
    return { ok: false, reason: "missing_country" };
  }

  // 3. Date sanity.
  const start = new Date(event.startDate);
  if (!Number.isFinite(start.getTime())) {
    return { ok: false, reason: "invalid_start_date" };
  }
  const end = new Date(event.endDate);
  if (!Number.isFinite(end.getTime())) {
    return { ok: false, reason: "invalid_end_date" };
  }
  if (end.getTime() < start.getTime()) {
    return { ok: false, reason: "end_before_start" };
  }

  const durationDays = (end.getTime() - start.getTime()) / 86_400_000;
  if (durationDays > MAX_DURATION_DAYS) {
    return { ok: false, reason: "duration_exceeds_max" };
  }

  const pastCutoff = new Date(now.getTime() - PAST_TOLERANCE_DAYS * 86_400_000);
  if (end.getTime() < pastCutoff.getTime()) {
    return { ok: false, reason: "ended_too_long_ago" };
  }

  const futureCutoff = new Date(now);
  futureCutoff.setUTCFullYear(futureCutoff.getUTCFullYear() + FUTURE_TOLERANCE_YEARS);
  if (start.getTime() > futureCutoff.getTime()) {
    return { ok: false, reason: "starts_too_far_in_future" };
  }

  // 4. ICAO format — exactly 4 uppercase A-Z when present.
  if (event.icaoCode != null && !/^[A-Z]{4}$/.test(event.icaoCode.trim())) {
    return { ok: false, reason: "invalid_icao" };
  }

  // 5. Coordinates — when the parser supplied them, must be in range.
  //    Geocoded coords are already range-checked in geocode.ts; this
  //    catches parser-supplied junk (a parser that mixed up lat/lon
  //    fields would emit lat=180, lon=52, both nominally finite).
  if (event.latitude != null && (event.latitude < -90 || event.latitude > 90)) {
    return { ok: false, reason: "invalid_coordinates" };
  }
  if (event.longitude != null && (event.longitude < -180 || event.longitude > 180)) {
    return { ok: false, reason: "invalid_coordinates" };
  }

  return { ok: true };
}
