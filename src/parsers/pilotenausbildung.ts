import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import { extractIcaoFromVenue } from "./vereinsflieger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pilotenausbildung.net /ausflugstipps/ parser.
//
// Source structure: a single static HTML page with five <h2> sections:
//
//   • Luftfahrt Museen          → reference data (museums), SKIP
//   • Luftfahrt Messen 2026     → trade-fair events
//   • Airshows/Flugshows 2026   → airshow events
//   • 2026: Fly-Inn's …         → meetup events
//   • Aktivitäten an Flughäfen  → reference data (airport activities), SKIP
//
// Within each event section, items are individual <p> blocks containing
// either:
//   <a href="…">DD.MM.YYYY – TITLE – LOCATION</a>
//   <a href="…">DD. – DD.MM.YYYY – TITLE – LOCATION</a>
//
// Cancelled items are wrapped in <del> — we drop those silently.
//
// The parser is intentionally lenient about whitespace inside the date
// range because the source is hand-curated and the operator types
// inconsistently across rows ("20. – 21. 02.2026", "04.- 06.06.2026",
// "20.-24.07.2026" all appear).
// ─────────────────────────────────────────────────────────────────────────────

interface SectionConfig {
  /** Lowercase substring matched against the <h2> text. */
  match: string;
  /** event_categories.code for rows in this section. */
  categoryCode: string;
}

/** Section-to-category mapping. Order matters: first match wins, and the
 *  reference-only sections (museums + airport activities) are
 *  intentionally absent so they are skipped. */
const SECTIONS: SectionConfig[] = [
  { match: "luftfahrt messen", categoryCode: "trade-fair" },
  { match: "airshows", categoryCode: "airshow" },
  { match: "flugshows", categoryCode: "airshow" },
  { match: "fly-inn", categoryCode: "meetup" },
  { match: "pilotentreffen", categoryCode: "meetup" },
];

/** Pick the matching SectionConfig for an <h2> heading. Returns null
 *  for the museum / airport-activities reference sections so the parser
 *  skips them. */
function classifySection(headingText: string): SectionConfig | null {
  const lower = headingText.toLowerCase();
  for (const s of SECTIONS) {
    if (lower.includes(s.match)) return s;
  }
  return null;
}

/** Looser sibling of vereinsflieger#parseGermanDateRange. Accepts the
 *  hand-typed variants the operator uses on this page. Examples it
 *  must handle:
 *
 *    "20.04.2026"
 *    "10. – 25.09.2026"
 *    "10.-25.09.2026"
 *    "10. - 25. 09.2026"
 *    "30. – 31.05.2026"
 *    "20. – 26.07.2026"
 *
 *  Returns null for anything else (including American MM/DD or pure
 *  prose). The first day in a range can be missing a `.MM.YYYY` suffix
 *  — the second day's month/year applies to both.
 */
export function parseLooseGermanDateRange(
  text: string,
): { startDate: string; endDate: string } | null {
  const t = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Range with optional dot/space after first day, hyphen / en-dash /
  // em-dash separator, second day always followed by .MM.YYYY.
  const range = t.match(
    /^(\d{1,2})\.?\s*[-–—]\s*(\d{1,2})\.\s*(\d{1,2})\.(\d{4})\b/,
  );
  if (range) {
    const [, d1, d2, mm, yyyy] = range;
    const start = toIsoMidnight(yyyy, mm, d1);
    const end = toIsoMidnight(yyyy, mm, d2);
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }
  // Range with explicit MM.YYYY on both sides (cross-month):
  // "30.05. – 02.06.2026" or "10.04.2026 - 25.09.2026"
  const cross = t.match(
    /^(\d{1,2})\.(\d{1,2})\.?(\d{4})?\s*[-–—]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\b/,
  );
  if (cross) {
    const [, d1, m1, y1, d2, m2, y2] = cross;
    const start = toIsoMidnight(y1 ?? y2, m1, d1);
    const end = toIsoMidnight(y2, m2, d2);
    if (!start || !end) return null;
    return { startDate: start, endDate: end };
  }
  // Single day.
  const single = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (single) {
    const [, d, m, y] = single;
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
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Best-effort country guess from the trailing location segment. Falls
 * back to "DE" when no marker matches — this page is German-curated
 * and the bulk of entries are domestic.
 */
function inferCountry(locationSegment: string): string {
  const lc = locationSegment.toLowerCase();
  if (/\b(usa|united states|us)\b/.test(lc)) return "US";
  if (/\b(uk|united kingdom|gb|great britain|england|wales|scotland)\b/.test(lc))
    return "GB";
  if (/\b(belgien|belgium)\b/.test(lc)) return "BE";
  if (/\b(brüssel|brussels|brussel)\b/.test(lc)) return "BE";
  if (/\b(frankreich|france)\b/.test(lc)) return "FR";
  if (/\b(österreich|oesterreich|austria)\b/.test(lc)) return "AT";
  if (/\b(schweiz|switzerland|suisse)\b/.test(lc)) return "CH";
  if (/\b(italien|italy)\b/.test(lc)) return "IT";
  if (/\b(spanien|spain|españa|espana)\b/.test(lc)) return "ES";
  if (/\b(niederlande|netherlands|holland)\b/.test(lc)) return "NL";
  if (/\b(tschechien|czech)\b/.test(lc)) return "CZ";
  if (/\b(polen|poland)\b/.test(lc)) return "PL";
  return "DE";
}

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/**
 * Split the trailing portion of an item ("DATE – TITLE – LOCATION")
 * into title + location. The first " – " separates date from
 * title+location; subsequent separators (en-dash, hyphen) split
 * title from venue. We treat the LAST separator as the title/location
 * boundary so multi-segment titles like
 * "Battle of Britain Airshow 2025 – Headcorn Aerodrome, UK" still
 * land as title="Battle of Britain Airshow 2025", location="Headcorn
 * Aerodrome, UK".
 */
function splitTitleAndLocation(rest: string): {
  title: string;
  location: string | null;
} {
  // Normalise separators.
  const normalised = rest
    .replace(/\u00a0/g, " ")
    .replace(/\s+[-–—]\s+/g, " – ");
  const segments = normalised.split(" – ").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { title: rest.trim(), location: null };
  if (segments.length === 1) return { title: segments[0], location: null };
  // Title = everything except last segment; location = last segment.
  const title = segments.slice(0, -1).join(" – ").trim();
  const location = segments[segments.length - 1].trim();
  return { title, location };
}

/**
 * Parse a /ausflugstipps/ page into ParsedEvent rows. Reference-only
 * sections (museums, airport activities) are skipped; cancelled items
 * (wrapped in <del>) are skipped silently.
 */
export function parsePilotenausbildungPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const events: ParsedEvent[] = [];
  let droppedCancelled = 0;
  let droppedUnparseableDate = 0;

  $("h2").each((_, h2) => {
    const headingText = cleanText($(h2).text());
    const sectionConfig = classifySection(headingText);
    if (!sectionConfig) return;

    // Walk forward through siblings until the next <h2>. Each <p>
    // along the way is a candidate event row.
    let node = $(h2).next();
    while (node.length && !node.is("h2")) {
      if (node.is("p")) {
        // Skip cancelled rows — wrapped in <del> by the curator.
        if (node.find("del").length > 0) {
          droppedCancelled++;
          node = node.next();
          continue;
        }

        const linkEl = node.find("a").first();
        const text = cleanText(node.text());
        if (!text) {
          node = node.next();
          continue;
        }

        // The text always starts with a date (range or single).
        // parseLooseGermanDateRange consumes the leading date then the
        // remainder is "title – location".
        const parsed = parseLooseGermanDateRange(text);
        if (!parsed) {
          droppedUnparseableDate++;
          node = node.next();
          continue;
        }

        // Remove the leading date prefix so we can split title/loc.
        const dateMatch = text.match(
          /^(\d{1,2}\.?\s*[-–—]?\s*\d{0,2}\.?\s*\d{0,2}\.?\d{4})\s*[-–—]?\s*/,
        );
        const rest = dateMatch
          ? text.slice(dateMatch[0].length).trim()
          : text;
        const { title, location } = splitTitleAndLocation(rest);
        if (!title) {
          node = node.next();
          continue;
        }

        const eventUrl = linkEl.attr("href")?.trim() || null;
        // Country lookup checks the location segment first, then falls
        // back to the title — many entries embed the country at the end
        // of the title ("Pardubice Airshow, Tschechien") with no
        // separate " – LOCATION" segment.
        const country = inferCountry(`${location ?? ""} ${title}`);
        // ICAO extraction: try the location segment first, then fall
        // back to the title (many Fly-In entries embed the ICAO inline:
        // "Blaulichttreffen am Flugplatz Bienenfarm (EDOI)").
        const icaoFromLocation = location
          ? extractIcaoFromVenue(location)
          : { name: "", icao: null };
        const { name: venueName, icao } = icaoFromLocation.icao
          ? icaoFromLocation
          : extractIcaoFromVenue(`${location ?? ""} ${title}`);

        const idHash = sha1Short(`${title}|${parsed.startDate}|${eventUrl ?? ""}`);
        const sourceUrl = `${pageUrl}#${idHash}`;

        events.push({
          sourceId: sourceUrl,
          sourceUrl,
          sourceName,
          pageUrl,
          sourceCategoryId: 0,
          categoryCode: sectionConfig.categoryCode,
          title,
          subtitle: null,
          dateRangeText: dateMatch ? dateMatch[0].trim() : null,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          timezone: "Europe/Berlin",
          country,
          city: null,
          venueName: venueName || location || title,
          icaoCode: icao,
          organizerName: "pilotenausbildung.net",
          description: location ? `${title} – ${location}` : title,
          eventUrl,
          sourceLocale: "de",
          latitude: null,
          longitude: null,
        });
      }
      node = node.next();
    }
  });

  if (droppedCancelled > 0 || droppedUnparseableDate > 0) {
    logger.warn("pilotenausbildung parser dropped rows", {
      pageUrl,
      droppedCancelled,
      droppedUnparseableDate,
      kept: events.length,
    });
  }

  return events;
}
