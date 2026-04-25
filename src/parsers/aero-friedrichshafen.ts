import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// aero-expo.com (AERO Friedrichshafen) parser.
//
// AERO Friedrichshafen is the European general-aviation trade fair held
// annually in Friedrichshafen. Unlike a calendar source, the homepage
// represents *one* event — so the parser emits at most one ParsedEvent
// per crawl. We mine:
//
//   - the `<title>` tag, which carries the dates: e.g.
//     "April 22 - 25, 2026 | AERO Friedrichshafen"
//   - the `<div class="date">` block in the header, which has the same
//     date string (used as a fallback if `<title>` is reformatted)
//   - `<meta property="og:description">` for the long-form description
//
// Date formats observed:
//   "April 22 - 25, 2026"        — typical
//   "April 22 – 25, 2026"        — en-dash variant
//   "April 22, 2026"             — single day (unlikely but possible)
//   "April 28 - May 1, 2026"     — cross-month (unlikely; covered)
//
// The crawler runs in two locales: aero-expo.com (English) and
// aero-expo.de (German). The parser reads the `<html lang>` attr and
// passes that through as `sourceLocale` so the translator emits the
// correct source-side text.
// ─────────────────────────────────────────────────────────────────────────────

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

const MONTHS_EN: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTHS_DE: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

function monthFromName(name: string): number | null {
  const k = name.toLowerCase().trim();
  return MONTHS_EN[k] ?? MONTHS_DE[k] ?? null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Parse an AERO Friedrichshafen date string into ISO timestamps.
 *
 * Supported shapes:
 *   "April 22 - 25, 2026"      same-month range
 *   "April 22, 2026"           single day
 *   "April 28 - May 1, 2026"   cross-month range
 *   "22. - 25. April 2026"     German same-month
 *   "22. April 2026"           German single day
 */
export function parseAeroDateRange(
  raw: string,
): { startDate: string; endDate: string } | null {
  const t = raw.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

  // English same-month range: "April 22 - 25, 2026"
  let m = t.match(
    /^([A-Za-zäöüÄÖÜ]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})$/,
  );
  if (m) {
    const [, mn, d1, d2, y] = m;
    const month = monthFromName(mn);
    if (!month) return null;
    const start = toIso(Number(y), month, Number(d1));
    const end = toIso(Number(y), month, Number(d2));
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }

  // English cross-month range: "April 28 - May 1, 2026"
  m = t.match(
    /^([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/,
  );
  if (m) {
    const [, mn1, d1, mn2, d2, y] = m;
    const m1 = monthFromName(mn1);
    const m2 = monthFromName(mn2);
    if (!m1 || !m2) return null;
    const start = toIso(Number(y), m1, Number(d1));
    const end = toIso(Number(y), m2, Number(d2));
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }

  // English single day: "April 22, 2026"
  m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const [, mn, d, y] = m;
    const month = monthFromName(mn);
    if (!month) return null;
    const iso = toIso(Number(y), month, Number(d));
    if (!iso) return null;
    return { startDate: iso, endDate: iso };
  }

  // German same-month range: "22. - 25. April 2026"
  m = t.match(
    /^(\d{1,2})\.\s*-\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})$/,
  );
  if (m) {
    const [, d1, d2, mn, y] = m;
    const month = monthFromName(mn);
    if (!month) return null;
    const start = toIso(Number(y), month, Number(d1));
    const end = toIso(Number(y), month, Number(d2));
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }

  // German single day: "22. April 2026"
  m = t.match(/^(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})$/);
  if (m) {
    const [, d, mn, y] = m;
    const month = monthFromName(mn);
    if (!month) return null;
    const iso = toIso(Number(y), month, Number(d));
    if (!iso) return null;
    return { startDate: iso, endDate: iso };
  }

  return null;
}

/**
 * Pull an AERO date string from the source HTML. Tries `<title>` first
 * (cleanest), falls back to `<div class="date">` text in the header.
 * Returns the raw date substring or null when nothing matches.
 */
export function extractAeroDateString(html: string): string | null {
  const $ = cheerio.load(html);

  // <title>April 22 - 25, 2026 | AERO Friedrichshafen</title>
  // <title>22. - 25. April 2026 | AERO Friedrichshafen</title>
  const title = $("title").first().text();
  const titleMatch = title.match(
    /^([^|]+?)\s*\|\s*AERO/i,
  );
  if (titleMatch) {
    const cand = titleMatch[1].trim();
    if (parseAeroDateRange(cand)) return cand;
  }

  // <div class="date"> April 22 - 25, 2026 </div>  (multi-line raw)
  const dateBlock = $(".date").first().text();
  const cleaned = cleanText(dateBlock);
  if (cleaned && parseAeroDateRange(cleaned)) return cleaned;

  // Last-ditch: scan the whole document for any well-formed AERO date.
  const docText = cleanText($("body").text());
  const months = "January|February|March|April|May|June|July|August|September|October|November|December|Januar|Februar|März|Mai|Juni|Juli|Oktober|Dezember";
  const re = new RegExp(
    `\\b(?:${months})\\s+\\d{1,2}\\s*(?:[-–—]\\s*(?:${months}\\s+)?\\d{1,2})?,?\\s*\\d{4}`,
    "i",
  );
  const fall = docText.match(re);
  if (fall && parseAeroDateRange(fall[0])) return fall[0];
  return null;
}

/** Best-effort source language detection. AERO publishes parallel
 *  English and German sites; we read `<html lang="…">` and default to
 *  English when missing. */
function detectLocale(html: string): "en" | "de" {
  const $ = cheerio.load(html);
  const lang = ($("html").attr("lang") ?? "").toLowerCase();
  if (lang.startsWith("de")) return "de";
  return "en";
}

/** Pull the long-form description from `<meta property="og:description">`,
 *  falling back to `<meta name="description">`. */
function extractDescription(html: string): string | null {
  const $ = cheerio.load(html);
  const og = $('meta[property="og:description"]').attr("content") ?? "";
  const desc = og || ($('meta[name="description"]').attr("content") ?? "");
  const cleaned = cleanText(desc);
  return cleaned || null;
}

export function parseAeroFriedrichshafenPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const dateText = extractAeroDateString(html);
  if (!dateText) {
    logger.warn("aero-friedrichshafen parser found no date string", { pageUrl });
    return [];
  }
  const range = parseAeroDateRange(dateText);
  if (!range) {
    logger.warn("aero-friedrichshafen parser failed to parse date string", {
      pageUrl,
      dateText,
    });
    return [];
  }

  const locale = detectLocale(html);
  const year = range.startDate.slice(0, 4);
  const title = locale === "de"
    ? `AERO Friedrichshafen ${year}`
    : `AERO Friedrichshafen ${year}`;
  const description = extractDescription(html);

  // Stable sourceUrl per year so the same crawl two days in a row
  // dedups (vs. constantly re-inserting). The crawl URL itself
  // (https://www.aero-expo.com/) is identical across years, so we
  // suffix it with the year extracted from the parsed date.
  const sourceUrl = `${pageUrl.replace(/\/$/, "")}/#${year}`;

  return [
    {
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl,
      sourceCategoryId: 0,
      categoryCode: "trade-fair",
      title,
      subtitle: locale === "de"
        ? "Die Leitmesse für die Allgemeine Luftfahrt"
        : "The Leading Show for General Aviation",
      dateRangeText: dateText,
      startDate: range.startDate,
      endDate: range.endDate,
      timezone: "Europe/Berlin",
      country: "DE",
      city: "Friedrichshafen",
      venueName: "Messe Friedrichshafen",
      icaoCode: "EDNY", // Friedrichshafen Bodensee Airport
      organizerName: "Messe Friedrichshafen GmbH",
      description: description ?? null,
      eventUrl: pageUrl,
      sourceLocale: locale,
      // Messe Friedrichshafen coordinates — saves a Nominatim hop
      // and keeps the map view responsive on the events page.
      latitude: 47.6716,
      longitude: 9.5111,
    },
  ];
}

export const _aeroInternals = { sha1Short };
