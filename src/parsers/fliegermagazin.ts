import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// fliegermagazin.de /termine/ parser.
//
// Source structure: paginated `/termine/seite/N/` (currently 4 pages),
// each page is a server-rendered list of <article> cards. Per card:
//
//   <article>
//     <a class="image-wrap" href="…">           ← canonical event URL
//     <div class="article-headline">termine</div>
//     <time class="article-time" datetime="…">  ← published date
//       10.04.2026 - 25.09.2026                  ← visible date range
//     <h3><a href="…">TITLE</a></h3>
//   </article>
//
// In addition, each page embeds a JSON blob in the bigmap section's
// `data-data` attribute with lat/long for events that the editor
// pinned to the map. We parse it as a side-channel to enrich the
// matching cards' coordinates — saves a Nominatim hit per event.
//
// Cloudflare CDN is in front of the site but the response is cacheable
// and returns 200 with the default Chrome UA. We do NOT identify as
// ClaudeBot / GPTBot / etc. — robots.txt explicitly disallows them.
// ─────────────────────────────────────────────────────────────────────────────

interface MapEntry {
  lat?: string;
  long?: string;
  from?: string;
  until?: string;
  title?: string;
  url?: string;
}

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Extract the embedded `data-data='{…}'` map blob from the bigmap
 *  section. Returns a Map keyed by event URL → coordinates so cards
 *  can pull their lat/long without a fuzzy match. Returns an empty
 *  Map if the blob is missing or malformed. */
export function extractBigmapCoords(html: string): Map<string, { lat: number; lon: number }> {
  const out = new Map<string, { lat: number; lon: number }>();
  // The blob is embedded as `data-data='{...}'` with HTML-escaped
  // quotes inside; we extract the JSON payload between the outer
  // single-quotes.
  const m = html.match(/data-data='(\{[^']+\})'/);
  if (!m) return out;
  try {
    const parsed = JSON.parse(m[1].replace(/&quot;/g, '"')) as Record<
      string,
      MapEntry
    >;
    for (const v of Object.values(parsed)) {
      if (!v.url || !v.lat || !v.long) continue;
      const lat = Number(v.lat);
      const lon = Number(v.long);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.set(v.url, { lat, lon });
    }
  } catch (err) {
    logger.debug("fliegermagazin bigmap blob parse failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

/** Parse the visible date range out of a card's `<time>` tag.
 *  Examples observed: "10.04.2026 - 25.09.2026", "09.05.2026",
 *  "09.05.2026 - 10.05.2026". */
export function parseFliegermagazinDateRange(
  text: string,
): { startDate: string; endDate: string } | null {
  const t = text.replace(/\s+/g, " ").trim();
  const range = t.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[-–—]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
  );
  if (range) {
    const [, d1, m1, y1, d2, m2, y2] = range;
    const start = toIsoMidnight(y1, m1, d1);
    const end = toIsoMidnight(y2, m2, d2);
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }
  const single = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (single) {
    const [, d, mo, y] = single;
    const iso = toIsoMidnight(y, mo, d);
    if (!iso) return null;
    return { startDate: iso, endDate: iso };
  }
  return null;
}

function toIsoMidnight(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Article-card category badge → event_categories.code. The site's own
 *  taxonomy uses German category labels in `<div data-headline>`. */
function classifyCategory(headline: string, title: string): string {
  const lc = headline.toLowerCase();
  const lt = title.toLowerCase();
  if (lc.includes("flugtag") || lt.includes("flugtag")) return "airfield-festival";
  if (lc.includes("messe") || lt.includes("messe") || lt.includes("expo"))
    return "trade-fair";
  if (lc.includes("airshow") || lt.includes("airshow") || lt.includes("flugshow"))
    return "airshow";
  if (lc.includes("seminar") || lt.includes("seminar") || lt.includes("schulung"))
    return "seminar";
  if (lc.includes("wettbewerb") || lt.includes("wettbewerb")) return "competition";
  if (/fly[-\s]?in|treffen/.test(lt)) return "meetup";
  return "general";
}

export function parseFliegermagazinPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const coords = extractBigmapCoords(html);
  const out: ParsedEvent[] = [];
  let droppedNoTitle = 0;
  let droppedNoDate = 0;

  // Cards live in <article> wrappers that contain a /termine/<slug>/
  // link. Filter strictly so the surrounding "related news" articles
  // don't slip in.
  $("article").each((_, el) => {
    const $el = $(el);
    // The category badge appears as either `[data-headline]` (current
    // template) or `.article-headline` (legacy template). Accept both.
    const headlineEl = $el
      .find(".article-item-content [data-headline], .article-item-content .article-headline, .article-headline")
      .first();
    const headline = cleanText(headlineEl.text());
    const titleEl = $el.find("h3 a").first();
    const link = (titleEl.attr("href") ?? "").trim();
    const title = cleanText(titleEl.text());
    if (!link || !link.includes("/termine/")) return;
    if (!title) {
      droppedNoTitle++;
      return;
    }
    const dateText = cleanText($el.find(".article-time").first().text());
    const range = parseFliegermagazinDateRange(dateText);
    if (!range) {
      droppedNoDate++;
      return;
    }

    const category = classifyCategory(headline, title);
    const coord = coords.get(link);

    const idHash = sha1Short(`${title}|${range.startDate.slice(0, 10)}`);
    const sourceUrl = link;

    out.push({
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl,
      sourceCategoryId: 0,
      categoryCode: category,
      title,
      subtitle: headline || null,
      dateRangeText: dateText || null,
      startDate: range.startDate,
      endDate: range.endDate,
      timezone: "Europe/Berlin",
      country: "DE",
      city: null,
      venueName: title,
      icaoCode: null,
      organizerName: "fliegermagazin.de",
      description: null,
      eventUrl: link,
      sourceLocale: "de",
      latitude: coord?.lat ?? null,
      longitude: coord?.lon ?? null,
    });
    void idHash;
  });

  if (droppedNoTitle > 0 || droppedNoDate > 0) {
    logger.warn("fliegermagazin parser dropped cards", {
      pageUrl,
      droppedNoTitle,
      droppedNoDate,
      kept: out.length,
    });
  }
  return out;
}

/**
 * Parse the "Seite X von Y" indicator in the page footer to discover
 * the total number of pagination pages. Returns 1 when the indicator
 * is absent (single-page result). The crawler uses this to discover
 * pages 2..N at runtime so we don't need to hardcode the page count.
 */
export function parseFliegermagazinTotalPages(html: string): number {
  const $ = cheerio.load(html);
  const text = $.root().text();
  const m = text.match(/Seite\s+\d+\s+von\s+(\d+)/i);
  if (!m) return 1;
  const total = Number(m[1]);
  return Number.isFinite(total) && total > 0 ? Math.min(total, 20) : 1;
}
