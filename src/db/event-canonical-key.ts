import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Cross-source dedup helper.
//
// The Tier-1 / vereinsflieger / ICS dedup is enforced by the partial UNIQUE
// index on (external_source, source_url). That catches *intra-source*
// duplicates only. Tier-2 aggregator sources (fliegermagazin reprints,
// ulforum reposts, pilotenausbildung curated tips, pilot-frank blog
// excerpts) regularly re-list the same fly-in / airshow already ingested
// from the primary organiser feed.
//
// The canonical_key below is computed *per-event*, INDEPENDENT of the
// source, so the upsertEvent path can compare a fresh aggregator row
// against an existing primary-source row and either skip the duplicate
// or supersede the lower-priority record.
//
// Construction (see EVENT_SOURCES_TIER2_AGGREGATORS.md §4.2):
//
//   canonical_key = sha1(
//     start_date_yyyymmdd
//     "|" + (icao_code ?? slugify(city ?? venue_name))
//     "|" + slugify(stripDiacritics(title)).slice(0, 40)
//   )
//
// - Date-only — events on the same day at the same venue with similar
//   titles are treated as the same event.
// - ICAO when present beats city/venue (strongest geographic anchor).
// - Title slug is diacritic-stripped + truncated so minor wording
//   differences across reprints still collide ("Tannkosh 2026 Fly-In"
//   vs "Fly-In Tannkosh 2026" both reduce to "tannkosh-2026-fly-in").
// ─────────────────────────────────────────────────────────────────────────────

/** Unicode-aware diacritic stripping. NFD splits combining marks; the
 *  follow-up regex drops the resulting `\p{Mn}` (Mark, Non-spacing)
 *  characters. Falls back gracefully if the runtime lacks the property
 *  escape (older Node) by using a literal range. Node 22 supports the
 *  Unicode property escape natively. */
export function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(/\p{Mn}/gu, "");
}

/** Slugify for the canonical-key title fragment. Lowercase, strip
 *  diacritics, collapse runs of non-alphanumerics into a single hyphen,
 *  trim leading/trailing hyphens. */
export function slugifyForKey(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pull the YYYYMMDD prefix off an ISO timestamp without timezone math.
 *  ParsedEvent.startDate is already UTC midnight per the parser
 *  conventions, so `.slice(0, 10).replace("-", "")` is correct. */
function startDateYyyymmdd(startIso: string): string {
  return startIso.slice(0, 10).replace(/-/g, "");
}

/**
 * Compute the canonical_key for a parsed event.
 *
 * Returns null when the parser didn't supply enough data to anchor the
 * key (no ICAO + no city + no venue, or no title). A null key means the
 * upsert path falls back to the existing (external_source, source_url)
 * dedup only — no cross-source linking is attempted. That's the safe
 * default: better to potentially store one extra duplicate than to
 * collapse two genuinely-distinct events under the same hash.
 */
export function computeCanonicalKey(
  event: Pick<
    ParsedEvent,
    "title" | "startDate" | "icaoCode" | "city" | "venueName"
  >,
): string | null {
  const titleFragment = slugifyForKey(event.title ?? "").slice(0, 40);
  if (!titleFragment) return null;

  const datePart = startDateYyyymmdd(event.startDate ?? "");
  // 8 digits, exact. Defensive: a malformed `not-a-date` slices to
  // 10 chars and after stripping the literal hyphen-positions still
  // collapses to 8 alphanumerics — checking digits-only catches it.
  if (!/^\d{8}$/.test(datePart)) return null;

  const venueAnchor =
    event.icaoCode?.trim() ||
    slugifyForKey(event.city ?? event.venueName ?? "");
  if (!venueAnchor) return null;

  const composite = `${datePart}|${venueAnchor}|${titleFragment}`;
  return createHash("sha1").update(composite).digest("hex");
}
