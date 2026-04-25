import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// nbaa.org /events/ parser.
//
// NBAA (National Business Aviation Association, US) publishes a single
// curated /events/ page — no pagination, ~25 cards per fetch, all
// future-dated.
//
// Card shape:
//   <div class='menu-event-single col'>
//     <a class="image-wrapper" href="/events/<slug>/"><img …></a>
//     <h5 class="menu-event-title"><a href="/events/<slug>/">TITLE</a></h5>
//     <div class="event-date">April 28, 2026</div>
//     <div class="location">Denver, CO</div>
//     <div class="menu-event-excerpt"><p>SHORT DESC</p></div>
//   </div>
//
// Date strings observed:
//   "April 28, 2026"      single day
//   "May 5-7, 2026"       same-month range
//   "Oct. 18-19, 2026"    abbreviated month
//   "Oct. 20-22, 2026"    same
//   "Sept. 28 - Oct. 1, 2026"  cross-month (defensive)
//
// All NBAA events are US-based; we always emit `country: "US"` and map
// the US-state abbreviation suffix in `location` to the full state for
// the city field. Non-US locations would require a parser update — at
// time of writing all 26 cards are US.
// ─────────────────────────────────────────────────────────────────────────────

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6,
  jul: 7, aug: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthFromName(name: string): number | null {
  const k = name.toLowerCase().replace(/\.$/, "").trim();
  return MONTHS[k] ?? null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Parse an NBAA card date string into ISO timestamps.
 *
 * Supported shapes:
 *   "April 28, 2026"             single day
 *   "May 5-7, 2026"              same-month range
 *   "Oct. 18-19, 2026"           abbrev. month + range
 *   "Sept. 28 - Oct. 1, 2026"    cross-month range
 */
export function parseNbaaDateRange(
  raw: string,
): { startDate: string; endDate: string } | null {
  const t = raw.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

  // Cross-month range: "Sept. 28 - Oct. 1, 2026"
  let m = t.match(
    /^([A-Za-z]+\.?)\s+(\d{1,2})\s*-\s*([A-Za-z]+\.?)\s+(\d{1,2}),\s*(\d{4})$/,
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

  // Same-month range: "May 5-7, 2026" or "Oct. 18-19, 2026"
  m = t.match(/^([A-Za-z]+\.?)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const [, mn, d1, d2, y] = m;
    const month = monthFromName(mn);
    if (!month) return null;
    const start = toIso(Number(y), month, Number(d1));
    const end = toIso(Number(y), month, Number(d2));
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }

  // Single day: "April 28, 2026"
  m = t.match(/^([A-Za-z]+\.?)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const [, mn, d, y] = m;
    const month = monthFromName(mn);
    if (!month) return null;
    const iso = toIso(Number(y), month, Number(d));
    if (!iso) return null;
    return { startDate: iso, endDate: iso };
  }

  return null;
}

/** Map an NBAA title → event_categories.code. Mostly seminars / training
 *  conferences with one big trade-show (BACE) per year. */
function classifyCategory(title: string): string {
  const lc = title.toLowerCase();
  if (/convention|exhibition|expo|bace\b/.test(lc)) return "trade-fair";
  if (/seminar|workshop|course|pdp/.test(lc)) return "seminar";
  if (/conference|symposium|forum|summit/.test(lc)) return "seminar";
  if (/awards|gala/.test(lc)) return "general";
  return "seminar";
}

/** Best-effort city/country from NBAA's "City, ST" format. NBAA events
 *  are always US-based; we trust the comma-suffix and map the rest of
 *  the world via parseGenericLocation when an entry slips through. */
function parseLocation(raw: string): { city: string | null; country: string } {
  const text = cleanText(raw);
  if (!text) return { city: null, country: "US" };
  // "Denver, CO" → city "Denver", country "US"
  const m = text.match(/^([^,]+),\s*([A-Z]{2})$/);
  if (m) return { city: m[1].trim(), country: "US" };
  // "Online" / "Virtual" → no city, virtual flag implied via title.
  if (/^(online|virtual)$/i.test(text)) {
    return { city: null, country: "US" };
  }
  return { city: text, country: "US" };
}

export function parseNbaaPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const out: ParsedEvent[] = [];
  let droppedNoTitle = 0;
  let droppedNoDate = 0;

  $(".menu-event-single").each((_, el) => {
    const $card = $(el);
    const title = cleanText(
      $card.find(".menu-event-title a").first().text(),
    ) || cleanText($card.find(".menu-event-title").first().text());
    if (!title) {
      droppedNoTitle++;
      return;
    }

    const hrefRaw = ($card.find(".menu-event-title a").first().attr("href")
      ?? $card.find("a.image-wrapper").first().attr("href")
      ?? "").trim();
    const link = hrefRaw === ""
      ? ""
      : hrefRaw.startsWith("http")
        ? hrefRaw
        : `https://nbaa.org${hrefRaw}`;

    const dateRaw = cleanText($card.find(".event-date").first().text());
    const range = parseNbaaDateRange(dateRaw);
    if (!range) {
      droppedNoDate++;
      return;
    }

    const locRaw = cleanText($card.find(".location").first().text());
    const { city, country } = parseLocation(locRaw);
    const description = cleanText(
      $card.find(".menu-event-excerpt p").first().text(),
    ) || null;

    const sourceUrl = link || `${pageUrl}#${sha1Short(`${title}|${range.startDate}`)}`;

    out.push({
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl,
      sourceCategoryId: 0,
      categoryCode: classifyCategory(title),
      title,
      subtitle: null,
      dateRangeText: dateRaw || null,
      startDate: range.startDate,
      endDate: range.endDate,
      // NBAA HQ is US-East; we use UTC because the cards don't carry
      // timezones. Downstream renders use the country to choose the
      // display TZ. (Aviation events page already does this.)
      timezone: "UTC",
      country,
      city,
      venueName: locRaw || title,
      icaoCode: null,
      organizerName: "NBAA",
      description,
      eventUrl: link || null,
      sourceLocale: "en",
      latitude: null,
      longitude: null,
    });
  });

  if (droppedNoTitle > 0 || droppedNoDate > 0) {
    logger.warn("nbaa parser dropped cards", {
      pageUrl,
      droppedNoTitle,
      droppedNoDate,
      kept: out.length,
    });
  }
  return out;
}

export const _nbaaInternals = { sha1Short, parseLocation, classifyCategory };
