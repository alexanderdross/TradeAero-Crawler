import { createHash } from "node:crypto";
import { parseIcs, type IcsEvent } from "../utils/ics.js";
import { cleanText } from "../utils/html.js";
import type { ParsedEvent } from "../types.js";
import type { IcsCalendar } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// ICS-feed parser.
//
// Each ICS calendar in config.sources.ics.calendars has its own metadata
// (default category, country, source language, organiser fallback). The
// parser threads those into ParsedEvent so the upsert pipeline gets a
// consistent shape regardless of feed quirks.
//
// Category mapping policy:
//   1. CATEGORIES line in the ICS event — match against event_categories.code
//   2. Fallback to calendar.defaultCategory
//
// (1) keeps publisher intent when they tag rigorously; (2) covers the
// long tail of feeds that just dump everything in.
// ─────────────────────────────────────────────────────────────────────────────

/** Recognised event_categories.code values. Mirrors the migration. */
const VALID_CATEGORY_CODES = new Set([
  "seminar",
  "competition",
  "flying-camp",
  "airfield-festival",
  "trade-fair",
  "airshow",
  "auction",
  "webinar",
  "meetup",
  "general",
]);

function pickCategoryCode(
  ics: IcsEvent,
  defaultCode: string,
): string {
  for (const c of ics.categories) {
    const norm = c.toLowerCase().replace(/\s+/g, "-");
    if (VALID_CATEGORY_CODES.has(norm)) return norm;
  }
  return VALID_CATEGORY_CODES.has(defaultCode) ? defaultCode : "general";
}

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Best-effort split of a free-text LOCATION into venue + city. ICS feeds
 *  put everything in one field; we keep the original string as venue and
 *  pull the last comma-separated chunk as city when present. */
function extractCity(location: string): { venue: string; city: string | null } {
  const v = cleanText(location);
  if (!v) return { venue: "", city: null };
  // "Venue Name, 12345 City, Country" — pull "City" out.
  const postal = v.match(/\b\d{4,5}\s+([A-Za-zÄÖÜäöüßÉÈÊÀÂÇéèêàâç\s'-]+)/);
  if (postal) return { venue: v, city: postal[1].trim() };
  const parts = v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { venue: parts[0], city: parts[1] };
  return { venue: v, city: null };
}

/** Strip a trailing ICAO `(EDXX)` from venue text, returning both. */
function extractIcao(text: string): { name: string; icao: string | null } {
  const t = text.trim();
  const m = t.match(/^(.*?)\s*\(\s*([A-Z]{4})\s*\)\s*$/);
  if (m) return { name: m[1].trim(), icao: m[2] };
  const inline = t.match(/\b([A-Z]{4})\b/);
  if (inline)
    return {
      name: t.replace(inline[0], "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim(),
      icao: inline[1],
    };
  return { name: t, icao: null };
}

export function parseIcsCalendar(
  icsText: string,
  calendar: IcsCalendar,
  sourceName: string,
): ParsedEvent[] {
  const events = parseIcs(icsText);
  const out: ParsedEvent[] = [];
  for (const ev of events) {
    if (!ev.summary || !ev.startIso) continue;

    const { venue, city } = extractCity(ev.location);
    const { name: venueName, icao } = extractIcao(venue);

    const categoryCode = pickCategoryCode(ev, calendar.defaultCategory);

    // Stable dedup key: same construction as Vereinsflieger so the same
    // partial UNIQUE INDEX serves both sources.
    const sourceIdHash = sha1Short(
      `${ev.summary}|${ev.startIso}|${calendar.organiserName ?? calendar.name}`,
    );
    const sourceUrl = `${calendar.url}#${sourceIdHash}`;

    out.push({
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl: calendar.url,
      // Vereinsflieger-shaped audit fields — ICS feeds have no native
      // numeric category, so we leave the source id as 0.
      sourceCategoryId: 0,
      categoryCode,
      title: cleanText(ev.summary),
      subtitle: null,
      dateRangeText: null,
      startDate: ev.startIso,
      endDate: ev.endIso,
      timezone: ev.tzid ?? calendar.timezone ?? "Europe/Berlin",
      country: calendar.country,
      city,
      venueName: venueName || calendar.name,
      icaoCode: icao,
      organizerName: calendar.organiserName ?? calendar.name,
      description: ev.description ? cleanText(ev.description) : null,
      eventUrl: ev.url,
      sourceLocale: calendar.sourceLocale ?? "en",
      latitude: null,
      longitude: null,
    });
  }
  return out;
}
