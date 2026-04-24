import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";

/**
 * Map source URL `?category=N` to the corresponding event_categories.code.
 * N=6 falls back to 'general' — a new code added by the companion refactor
 * migration `20260424_vereinsflieger_event_support.sql`.
 */
const CATEGORY_MAP: Record<number, string> = {
  1: "seminar",
  2: "competition",
  3: "flying-camp",
  4: "airfield-festival",
  5: "trade-fair",
  6: "general",
};

export function categoryCodeForSourceId(id: number): string {
  return CATEGORY_MAP[id] ?? "general";
}

/** Extract `category=N` from a publiccalendar URL. */
function parseSourceCategoryId(pageUrl: string): number {
  const m = pageUrl.match(/[?&]category=(\d+)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 6 ? n : 6;
}

/**
 * Parse a German date / date-range. Accepts:
 *   "24.04.2026"
 *   "24.04.2026 - 26.04.2026"
 *
 * Returns both start and end as ISO-8601 midnight UTC strings. End equals
 * start for single-day events. Returns null on unparseable input.
 *
 * Note: times are not exposed by the source. Using midnight UTC (rather than
 * Europe/Berlin midnight) trades ~1–2h of timezone drift for simplicity —
 * downstream consumers use the `timezone` column to display correctly. The
 * CHECK (end_date >= start_date) constraint on aviation_events is respected.
 */
export function parseGermanDateRange(
  text: string,
): { startDate: string; endDate: string } | null {
  const rangeMatch = text.match(
    /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[-–—]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/,
  );
  if (rangeMatch) {
    const [, d1, m1, y1, d2, m2, y2] = rangeMatch;
    const start = toIsoMidnight(y1, m1, d1);
    const end = toIsoMidnight(y2, m2, d2);
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }
  const singleMatch = text.match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/);
  if (singleMatch) {
    const [, d, m, y] = singleMatch;
    const iso = toIsoMidnight(y, m, d);
    if (!iso) return null;
    return { startDate: iso, endDate: iso };
  }
  return null;
}

function toIsoMidnight(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Strip a trailing ICAO code `(EDXX)` from venue text and return both
 * parts. Returns { name, icao: null } when no ICAO is present.
 */
export function extractIcaoFromVenue(
  raw: string,
): { name: string; icao: string | null } {
  const text = cleanText(raw);
  if (!text) return { name: "", icao: null };
  const m = text.match(/^(.*?)\s*\(\s*([A-Z]{4})\s*\)\s*$/);
  if (m) return { name: m[1].trim(), icao: m[2] };
  // Also match when ICAO appears inline, not at end
  const inline = text.match(/\b([A-Z]{4})\b/);
  if (inline) {
    const name = text.replace(inline[0], "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();
    return { name: name || text, icao: inline[1] };
  }
  return { name: text, icao: null };
}

/**
 * Best-effort city extraction from venue text. Looks for a German 5-digit
 * postal code ("12345 City") or a "Stadt, Land" comma split. Falls back to
 * null so callers can use venueName as the city hint.
 */
export function extractCityFromVenue(venueName: string): string | null {
  if (!venueName) return null;
  const postalMatch = venueName.match(/\b\d{5}\s+([A-Za-zÄÖÜäöüß\s-]+)\b/);
  if (postalMatch) return postalMatch[1].trim();
  const commaMatch = venueName.match(/^([^,]+),\s*([A-Za-zÄÖÜäöüß\s-]+)$/);
  if (commaMatch) return commaMatch[2].trim();
  return null;
}

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/**
 * Parse a vereinsflieger.de/publiccalendar/?category=N page into
 * ParsedEvent rows. Returns an empty array on an empty table (e.g. a
 * category with no upcoming events) — the orchestrator treats that as a
 * successful zero-row parse, not an error.
 */
export function parseVereinsfliegerPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const sourceCategoryId = parseSourceCategoryId(pageUrl);
  const categoryCode = categoryCodeForSourceId(sourceCategoryId);

  const events: ParsedEvent[] = [];

  $("tr").each((_, row) => {
    const $row = $(row);

    // Skip month header rows (td colspan=2 + inline background-color).
    if ($row.find("td[colspan='2']").length && !$row.find(".pubcal_title").length) return;

    const titleEl = $row.find(".pubcal_title").first();
    if (!titleEl.length) return;
    const title = cleanText(titleEl.text());
    if (!title) return;

    const dateText = cleanText($row.find(".pubcal_daterange.icon-clock").first().text());
    const parsedRange = parseGermanDateRange(dateText);
    if (!parsedRange) {
      logger.debug("Skipping row with unparseable date", { title, dateText });
      return;
    }

    const subtitle = cleanText($row.find(".pubcal_daterange.icon-info").first().text()) || null;

    const venueRaw = cleanText($row.find(".pubcal_location").first().text());
    const { name: venueName, icao: icaoCode } = extractIcaoFromVenue(venueRaw);
    const city = extractCityFromVenue(venueName);

    const organizerName = cleanText($row.find(".pubcal_cidname").first().text());
    if (!organizerName) {
      logger.debug("Skipping row with no organizer", { title });
      return;
    }

    const sourceIdHash = sha1Short(`${title}|${parsedRange.startDate}|${organizerName}`);
    const sourceUrl = `${pageUrl}#${sourceIdHash}`;

    events.push({
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl,
      sourceCategoryId,
      categoryCode,
      title,
      subtitle,
      dateRangeText: dateText || null,
      startDate: parsedRange.startDate,
      endDate: parsedRange.endDate,
      timezone: "Europe/Berlin",
      country: "DE",
      city,
      venueName: venueName || "Unbekannt",
      icaoCode,
      organizerName,
    });
  });

  logger.debug("Parsed vereinsflieger page", {
    pageUrl,
    category: categoryCode,
    events: events.length,
  });

  return events;
}

/**
 * Build the description payload that gets stored in aviation_events.description.
 * Source has no description field — we synthesize one from the available
 * metadata so admins have something readable. The Claude Haiku translator
 * then localizes the full sentence.
 */
export function synthesizeEventDescription(event: ParsedEvent): string {
  const parts: string[] = [];
  if (event.subtitle) parts.push(event.subtitle);
  if (event.dateRangeText) parts.push(event.dateRangeText);
  if (event.venueName) parts.push(event.venueName);
  if (event.organizerName) parts.push(`Veranstalter: ${event.organizerName}`);
  return parts.join(" – ");
}
