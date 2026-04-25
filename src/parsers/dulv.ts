import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import {
  parseGermanDateRange,
  extractIcaoFromVenue,
  extractCityFromVenue,
} from "./vereinsflieger.js";

// ─────────────────────────────────────────────────────────────────────────────
// dulv.de /veranstaltungen parser.
//
// Source structure: Drupal `views-element-container` rendering one
// `.layout--twocol` block per event. Each block carries the Drupal node
// id as a `data-history-node-id` attribute that doubles as the canonical
// detail-page key (`/node/N`).
//
// Field selectors (all `.field--name-field-<name>`):
//   field-bild        — image (alt= used as the title-of-last-resort)
//   field-startdatum  — "01.05.2026"
//   field-enddatum    — "01.05.2026"
//   field-ort         — "Jesenwang EDMJ"  /  "Schmallenberg-Rennefeld (EDKR)"
//   field-beschreibung — multi-paragraph HTML (we strip + use first ~600 chars)
//
// Title extraction is the only quirk: the listings page does NOT render
// a per-row title heading. We build the title from:
//   1. the `field-bild` `<img alt="…">` if it has spaces (operator typed
//      a clean alt — e.g. "UL-Fly-In Jesenwang");
//   2. else the first `<h3>`/`<h4>` inside the description (operator
//      sometimes uses a heading as the marketing title);
//   3. else the first sentence of the description.
//
// Pagination follows Drupal's `?page=N` 0-indexed scheme — a separate
// crawler shim probes total pages and adds them to the run plan.
// ─────────────────────────────────────────────────────────────────────────────

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Map a DULV title → event_categories.code. The org publishes a mix of
 *  fly-ins, training events, and member meetups. Default `meetup` keeps
 *  the row inside the events page even when no keyword matches. */
function classifyCategory(title: string): string {
  const lc = title.toLowerCase();
  if (/airshow|flugshow|flugtag/.test(lc)) return "airshow";
  if (/wettbewerb|meisterschaft|\bdm\b|cup\b|championship/.test(lc)) {
    return "competition";
  }
  if (/seminar|fortbildung|schulung|lehrgang|infotag|infotage/.test(lc)) {
    return "seminar";
  }
  if (/messe|trade fair|expo\b/.test(lc)) return "trade-fair";
  if (/fly[-\s]?in|treffen|festival|pilotenparty/.test(lc)) return "meetup";
  return "meetup";
}

/** Pull the cleanest title we can from one event block. See the strategy
 *  in the file header. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickTitle($block: cheerio.Cheerio<any>, description: string): string {
  const altRaw = $block.find(".field--name-field-bild img").attr("alt") ?? "";
  const alt = cleanText(altRaw);
  // A clean operator-supplied alt has whitespace or hyphens — filenames
  // tend to be one CamelCase word like "Waffelflyin". Use the alt
  // directly when it has either character.
  if (alt && /[\s-]/.test(alt)) return alt;

  // Try the first heading inside the description — operators sometimes
  // use H3/H4 as a marketing line above the body copy.
  // (We're parsing the cheerio root via $block, so re-load the
  // beschreibung block as HTML to get cheerio nav.)
  const $desc = $block.find(".field--name-field-beschreibung").first();
  const heading = cleanText($desc.find("h3, h4").first().text());
  if (heading) return heading;

  // Fall back to the first sentence of the cleaned description. Sentence
  // boundary = "." / "!" / "?" followed by whitespace, but NOT when the
  // preceding character is a digit (so "Das 5. Waffel Fly-In findet am
  // Sonntag." stays as one sentence). Cap at 120 chars.
  const firstSentence = description.split(/(?<=(?<!\d)[.!?])\s+/)[0]?.trim() ?? "";
  if (firstSentence && firstSentence.length <= 120) return firstSentence;
  if (firstSentence) return firstSentence.slice(0, 120).trim();

  // Last resort: the alt even if it's a filename — better than empty.
  return alt || "DULV Veranstaltung";
}

export function parseDulvPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const out: ParsedEvent[] = [];
  let droppedNoDate = 0;
  let droppedNoTitle = 0;

  $("[data-history-node-id]").each((_, el) => {
    const $block = $(el);
    const nodeId = ($block.attr("data-history-node-id") ?? "").trim();
    if (!nodeId) return;
    const detailUrl = `https://www.dulv.de/node/${nodeId}`;

    const startRaw = cleanText(
      $block.find(".field--name-field-startdatum .field__item").first().text(),
    );
    const endRaw = cleanText(
      $block.find(".field--name-field-enddatum .field__item").first().text(),
    );
    if (!startRaw) {
      droppedNoDate++;
      return;
    }
    // Build a `dd.mm.yyyy - dd.mm.yyyy` string when a different end date
    // is present, else single-day. Reuses the vereinsflieger parser.
    const dateInput = endRaw && endRaw !== startRaw
      ? `${startRaw} - ${endRaw}`
      : startRaw;
    const range = parseGermanDateRange(dateInput);
    if (!range) {
      droppedNoDate++;
      return;
    }

    const venueRaw = cleanText(
      $block.find(".field--name-field-ort .field__item").first().text(),
    );

    const descBlock = $block
      .find(".field--name-field-beschreibung .field__item")
      .first();
    // Read .html() (not .text()) so cleanText replaces block-level tags
    // with whitespace — otherwise back-to-back `</p><p>` becomes one
    // continuous run and sentence-boundary detection breaks.
    const description = cleanText(descBlock.html() ?? "").slice(0, 1200);

    const title = pickTitle($block, description);
    if (!title) {
      droppedNoTitle++;
      return;
    }

    const { name: venueName, icao } = extractIcaoFromVenue(venueRaw || title);
    const cityFromVenue = extractCityFromVenue(venueRaw);
    const city = cityFromVenue ?? (venueName.split(/[,(]/)[0].trim() || null);

    const dedupKey = sha1Short(
      `${detailUrl}|${title}|${range.startDate}|${nodeId}`,
    );

    out.push({
      sourceId: detailUrl,
      sourceUrl: detailUrl,
      sourceName,
      pageUrl,
      sourceCategoryId: 0,
      categoryCode: classifyCategory(title),
      title,
      subtitle: null,
      dateRangeText: dateInput,
      startDate: range.startDate,
      endDate: range.endDate,
      timezone: "Europe/Berlin",
      country: "DE",
      city,
      venueName: venueName || title,
      icaoCode: icao,
      organizerName: "DULV",
      description: description || null,
      eventUrl: detailUrl,
      sourceLocale: "de",
      latitude: null,
      longitude: null,
    });

    // dedupKey is unused at the row level (the partial UNIQUE index uses
    // (external_source, source_url) which is the detailUrl above), but
    // we compute it so a future fixture-only sourceUrl variant has a
    // stable handle. Suppress the "unused" lint by referencing it.
    void dedupKey;
  });

  if (droppedNoTitle > 0 || droppedNoDate > 0) {
    logger.warn("dulv parser dropped rows", {
      pageUrl,
      droppedNoTitle,
      droppedNoDate,
      kept: out.length,
    });
  }
  return out;
}

/** Pull the largest visible `?page=N` value from DULV's pager. Drupal
 *  uses 0-indexed pagination — page 1 is the default URL, page 2 is
 *  `?page=1`, page N is `?page=N-1`. Returns the largest *zero-based*
 *  index present, so a return of 1 means "two pages exist". */
export function parseDulvLastPageIndex(html: string): number {
  const $ = cheerio.load(html);
  let max = 0;
  $("a[href*='page=']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/[?&]page=(\d+)/);
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return Math.min(max, 9);
}

export const _dulvInternals = { sha1Short, pickTitle, classifyCategory };
