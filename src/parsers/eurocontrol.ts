import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// eurocontrol.int /events parser.
//
// Eurocontrol's Drupal CMS renders cards into:
//
//   <div class="node node--event ... card">
//     <div class="card-img-top">…<img></div>
//     <div class="card-header">
//       <div class="field--ref-event-type ...">Event | Webinar | Workshop</div>
//     </div>
//     <div class="card-body">
//       <div class="field--date-range ...">
//         <div class="field__item">
//           <time datetime="2026-05-06T07:30:00Z">6 May 2026</time>
//         </div>
//       </div>
//       <div class="field--promo-title ...">
//         <h3 class="h5">2026 EU MITRE ATT&CK® Community Workshop</h3>
//       </div>
//     </div>
//     <div class="card-footer">
//       <a href="/event/<slug>" class="btn ...">Register</a>
//     </div>
//   </div>
//
// Cross-day events nest TWO `<time>` elements inside one `field__item`:
//   <time datetime="2026-06-03T10:00:00Z">3</time>
//   - <time datetime="2026-06-04T07:00:00Z">4 June 2026</time>
//
// We always read the FIRST and LAST `<time>` element's datetime
// attribute — single-day events have only one `<time>`, so first === last.
// All `datetime` values are ISO 8601 with a Z (UTC) suffix; we coerce
// them to UTC midnight to match the rest of the events pipeline.
// ─────────────────────────────────────────────────────────────────────────────

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Coerce an ISO timestamp into UTC midnight of the same calendar day. */
function toUtcMidnightIso(input: string | undefined | null): string | null {
  if (!input) return null;
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Map a Eurocontrol event type or title → event_categories.code. The
 *  CMS surfaces a per-card type label ("Event" / "Webinar" / "Workshop"
 *  / "Conference") that we trust over title-keyword classification. */
function classifyCategory(eventType: string, title: string): string {
  const type = eventType.toLowerCase().trim();
  if (type === "webinar") return "webinar";
  if (type === "workshop" || type === "training") return "seminar";
  if (type === "conference" || type === "forum") return "seminar";
  // Fall through to title-keyword classification when the type is the
  // generic "Event" (most cards use it).
  const lc = title.toLowerCase();
  if (/forum|symposium|summit|conference|congress|meeting/.test(lc)) {
    return "seminar";
  }
  if (/workshop|webinar|training|course/.test(lc)) return "seminar";
  if (/awards|gala/.test(lc)) return "general";
  return "seminar";
}

export function parseEurocontrolPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const out: ParsedEvent[] = [];
  let droppedNoTitle = 0;
  let droppedNoDate = 0;

  $(".node--event").each((_, el) => {
    const $card = $(el);
    const title = cleanText(
      $card.find(".field--promo-title h3").first().text(),
    ) || cleanText($card.find(".field--promo-title").first().text());
    if (!title) {
      droppedNoTitle++;
      return;
    }

    const $times = $card.find(".field--date-range time");
    const startAttr = $times.first().attr("datetime") ?? "";
    const endAttr = $times.last().attr("datetime") ?? startAttr;
    const start = toUtcMidnightIso(startAttr);
    const end = toUtcMidnightIso(endAttr);
    if (!start || !end) {
      droppedNoDate++;
      return;
    }

    const dateRangeText = cleanText($card.find(".field--date-range").first().text());
    const eventType = cleanText(
      $card.find(".field--ref-event-type").first().text(),
    );
    const href = ($card.find(".card-footer a").first().attr("href")
      ?? "").trim();
    const link = href === ""
      ? ""
      : href.startsWith("http")
        ? href
        : `https://www.eurocontrol.int${href}`;

    const sourceUrl = link
      || `${pageUrl}#${sha1Short(`${title}|${start}`)}`;

    out.push({
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl,
      sourceCategoryId: 0,
      categoryCode: classifyCategory(eventType, title),
      title,
      subtitle: eventType || null,
      dateRangeText: dateRangeText || null,
      startDate: start,
      endDate: end,
      timezone: "UTC",
      // Eurocontrol HQ is in Brussels but their events are pan-European.
      // Without per-event location data on the listing card we leave the
      // country at BE (HQ) and let the per-event detail page (a future
      // enhancement) refine it.
      country: "BE",
      city: null,
      venueName: title,
      icaoCode: null,
      organizerName: "Eurocontrol",
      description: eventType ? `${eventType} — ${title}` : title,
      eventUrl: link || null,
      sourceLocale: "en",
      latitude: null,
      longitude: null,
    });
  });

  if (droppedNoTitle > 0 || droppedNoDate > 0) {
    logger.warn("eurocontrol parser dropped cards", {
      pageUrl,
      droppedNoTitle,
      droppedNoDate,
      kept: out.length,
    });
  }
  return out;
}

/** Pull the largest visible `?page=N` value from Eurocontrol's pager.
 *  Drupal uses 0-indexed pagination — return value of 7 means "8 total
 *  pages", so the crawler shim ranges 1..7 to fetch beyond page 0. */
export function parseEurocontrolLastPageIndex(html: string): number {
  const $ = cheerio.load(html);
  let max = 0;
  $("a[href*='page=']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/[?&]page=(\d+)/);
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return Math.min(max, 19);
}

export const _eurocontrolInternals = { sha1Short, toUtcMidnightIso, classifyCategory };
