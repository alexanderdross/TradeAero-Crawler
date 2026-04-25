import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// iata.org /en/events/ parser.
//
// Source structure: paginated `?page=N#searchForm`, faceted by
// category + region. Sitecore CMS renders cards into:
//
//   <div class="… global-event-list-item-wrapper">
//     <a class="global-event-list-item" href="/en/events/all/<slug>/">
//       <img class="global-event-list-item-img" />
//       <div class="global-event-list-item-content">
//         <h4 class="global-event-list-title">TITLE</h4>
//         <div class="global-event-list-item-venue">CITY, COUNTRY</div>
//         <div class="global-event-list-item-date">DD - DD Month</div>
//       </div>
//     </a>
//   </div>
//
// Quirks:
//   - Dates have no year (e.g. "12 - 14 May", "28 Sep - 02 Oct").
//     We infer year from a reference Date (default = today): assume
//     current year, and roll over to next year if the parsed date is
//     more than 30 days in the past — IATA only lists future events,
//     so a "past" date almost certainly means next year.
//   - Cross-month ranges ("28 Sep - 02 Oct") have separate months on
//     each side of the dash.
//   - Single-day events use just "DD Month" (no dash).
// ─────────────────────────────────────────────────────────────────────────────

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function monthFromName(name: string): number | null {
  const m = MONTHS[name.toLowerCase()];
  return m ?? null;
}

/** Pick a year for a (month, day) tuple given a reference instant.
 *  Rule: try the reference year; if the result is >30 days in the
 *  past, roll over to the next year. */
function pickYear(month: number, day: number, ref: Date): number {
  const refYear = ref.getUTCFullYear();
  const candidate = new Date(Date.UTC(refYear, month - 1, day));
  const cutoff = new Date(ref.getTime() - 30 * 86_400_000);
  if (candidate.getTime() < cutoff.getTime()) return refYear + 1;
  return refYear;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Parse IATA's compact card date strings into UTC midnight ISO
 * timestamps. Returns null when the input doesn't match any pattern.
 *
 * Supported shapes:
 *   "12 May"               → single day
 *   "12 - 14 May"          → range, same month
 *   "28 Sep - 02 Oct"      → range, cross-month
 *   "28 Dec - 02 Jan"      → range, cross-year (end > start in calendar)
 */
export function parseIataDateRange(
  text: string,
  now: Date = new Date(),
): { startDate: string; endDate: string } | null {
  const t = text.replace(/\s+/g, " ").trim();
  // Range with separate months on each side ("28 Sep - 02 Oct")
  const cross = t.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)$/,
  );
  if (cross) {
    const [, d1, mn1, d2, mn2] = cross;
    const m1 = monthFromName(mn1);
    const m2 = monthFromName(mn2);
    if (!m1 || !m2) return null;
    const y1 = pickYear(m1, Number(d1), now);
    // Cross-year guard: if end month < start month (e.g. Dec → Jan),
    // bump end's year by 1.
    const y2 = m2 >= m1 ? y1 : y1 + 1;
    const start = toIso(y1, m1, Number(d1));
    const end = toIso(y2, m2, Number(d2));
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }
  // Range with shared month ("12 - 14 May")
  const sameMonth = t.match(
    /^(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)$/,
  );
  if (sameMonth) {
    const [, d1, d2, mn] = sameMonth;
    const m = monthFromName(mn);
    if (!m) return null;
    const y = pickYear(m, Number(d1), now);
    const start = toIso(y, m, Number(d1));
    const end = toIso(y, m, Number(d2));
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }
  // Single day ("12 May")
  const single = t.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (single) {
    const [, d, mn] = single;
    const m = monthFromName(mn);
    if (!m) return null;
    const y = pickYear(m, Number(d), now);
    const iso = toIso(y, m, Number(d));
    if (!iso) return null;
    return { startDate: iso, endDate: iso };
  }
  return null;
}

/** Map "City, Country" venue strings to ISO 3166 alpha-2 country codes.
 *  Only covers the IATA event hosting countries — extend as new venues
 *  appear. Falls back to "XX" so validateEvent's missing_country drop
 *  catches anything unexpected. */
const COUNTRY_MAP: Record<string, string> = {
  france: "FR",
  germany: "DE",
  switzerland: "CH",
  belgium: "BE",
  italy: "IT",
  spain: "ES",
  uk: "GB",
  "united kingdom": "GB",
  ireland: "IE",
  "united states": "US",
  usa: "US",
  canada: "CA",
  mexico: "MX",
  brazil: "BR",
  argentina: "AR",
  uae: "AE",
  "united arab emirates": "AE",
  qatar: "QA",
  "saudi arabia": "SA",
  jordan: "JO",
  egypt: "EG",
  morocco: "MA",
  "south africa": "ZA",
  india: "IN",
  china: "CN",
  japan: "JP",
  singapore: "SG",
  korea: "KR",
  "south korea": "KR",
  malaysia: "MY",
  thailand: "TH",
  indonesia: "ID",
  vietnam: "VN",
  australia: "AU",
  "new zealand": "NZ",
  netherlands: "NL",
  poland: "PL",
  turkey: "TR",
  türkiye: "TR",
  turkiye: "TR",
  greece: "GR",
  hungary: "HU",
  bahrain: "BH",
  oman: "OM",
  kenya: "KE",
  nigeria: "NG",
  ethiopia: "ET",
  philippines: "PH",
  taiwan: "TW",
  pakistan: "PK",
  "hong kong": "HK",
  macau: "MO",
};

export function parseIataVenue(
  raw: string,
): { city: string | null; country: string } {
  const text = cleanText(raw);
  if (!text) return { city: null, country: "XX" };
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, country: "XX" };
  const city = parts.length >= 2 ? parts[0] : null;
  const countryName = parts[parts.length - 1].toLowerCase();
  const code = COUNTRY_MAP[countryName] ?? "XX";
  return { city, country: code };
}

function classifyCategory(title: string): string {
  const lc = title.toLowerCase();
  if (/forum|symposium|summit/.test(lc)) return "seminar";
  if (/conference|congress|meeting|agm/.test(lc)) return "seminar";
  if (/expo|exhibition|fair/.test(lc)) return "trade-fair";
  if (/awards|gala/.test(lc)) return "general";
  return "seminar";
}

export function parseIataPage(
  html: string,
  pageUrl: string,
  sourceName: string,
  now: Date = new Date(),
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const out: ParsedEvent[] = [];
  let droppedNoTitle = 0;
  let droppedNoDate = 0;

  $("a.global-event-list-item").each((_, el) => {
    const $el = $(el);
    const href = ($el.attr("href") ?? "").trim();
    if (!href) return;
    const link = href.startsWith("http")
      ? href
      : `https://www.iata.org${href}`;
    const title = cleanText($el.find(".global-event-list-title").first().text());
    if (!title) {
      droppedNoTitle++;
      return;
    }
    const venueRaw = cleanText(
      $el.find(".global-event-list-item-venue").first().text(),
    );
    const dateRaw = cleanText(
      $el.find(".global-event-list-item-date").first().text(),
    );
    const range = parseIataDateRange(dateRaw, now);
    if (!range) {
      droppedNoDate++;
      return;
    }
    const { city, country } = parseIataVenue(venueRaw);

    out.push({
      sourceId: link,
      sourceUrl: link,
      sourceName,
      pageUrl,
      sourceCategoryId: 0,
      categoryCode: classifyCategory(title),
      title,
      subtitle: null,
      dateRangeText: dateRaw || null,
      startDate: range.startDate,
      endDate: range.endDate,
      timezone: "UTC",
      country,
      city,
      venueName: venueRaw || title,
      icaoCode: null,
      organizerName: "IATA",
      description: venueRaw ? `${title} – ${venueRaw}` : title,
      eventUrl: link,
      sourceLocale: "en",
      latitude: null,
      longitude: null,
    });
  });

  if (droppedNoTitle > 0 || droppedNoDate > 0) {
    logger.warn("iata parser dropped cards", {
      pageUrl,
      droppedNoTitle,
      droppedNoDate,
      kept: out.length,
    });
  }
  return out;
}

/** Pull the total page count from IATA's pagination block. The site
 *  renders `<a href="?page=N">N</a>` links and we just take the
 *  largest visible number. Returns 1 when no pagination is present. */
export function parseIataTotalPages(html: string): number {
  const $ = cheerio.load(html);
  let max = 1;
  $("a[href*='page=']").each((_, el) => {
    const txt = $(el).text().trim();
    const n = Number(txt);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return Math.min(max, 20);
}

// Internal helper — re-exported for tests so we can pin the
// year-rollover behaviour deterministically.
export const _iataInternals = { sha1Short };
