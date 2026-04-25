import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import { extractIcaoFromVenue, extractCityFromVenue } from "./vereinsflieger.js";

// ─────────────────────────────────────────────────────────────────────────────
// pilot-frank.de RSS parser.
//
// Source is a WordPress + Modern Events Calendar (MEC) RSS feed at
// /events/feed/. Each <item> carries the rich `mec:` namespace fields
// the plugin emits — startDate, endDate, location — alongside the
// standard RSS title/link/description. We rely exclusively on the RSS
// payload (no HTML scraping required).
//
// We use cheerio in xmlMode to avoid adding an XML-parser dependency:
// RSS is regular enough that a tag-aware traversal is sufficient.
//
// MEC location field is optional: many of pilot-frank's posts embed the
// venue inside the description body instead. When mec:location is
// absent we fall back to title-side ICAO extraction so the canonical_key
// still has a venue anchor for cross-source dedup.
// ─────────────────────────────────────────────────────────────────────────────

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

function toUtcMidnightIso(input: string | undefined | null): string | null {
  if (!input) return null;
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Strip the leading <img> thumbnail and the trailing
 *  "The post X appeared first on Y" attribution that MEC injects, then
 *  collapse remaining HTML to plain text via cleanText. */
function cleanDescription(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const stripped = cleanText(
    raw
      .replace(/<img[^>]*>/g, "")
      .replace(/The post .* appeared first on .*/, ""),
  );
  return stripped || null;
}

function classifyCategory(title: string): string {
  const lc = title.toLowerCase();
  if (/airshow|flugshow|flugtag/.test(lc)) return "airshow";
  if (/wettbewerb|meisterschaft|cup\b/.test(lc)) return "competition";
  if (/seminar|fortbildung|schulung/.test(lc)) return "seminar";
  if (/messe|expo\b|aero\b/.test(lc)) return "trade-fair";
  if (/fly[-\s]?in|pilotentreffen|treffen|hangar/.test(lc)) return "meetup";
  return "general";
}

export function parsePilotFrankFeed(
  xml: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  if (!xml.trim().startsWith("<?xml")) {
    logger.warn(
      "pilot-frank feed didn't start with <?xml — possible HTML wall",
      { pageUrl, preview: xml.slice(0, 80) },
    );
    return [];
  }

  const $ = cheerio.load(xml, { xmlMode: true });
  const out: ParsedEvent[] = [];
  let droppedNoTitle = 0;
  let droppedNoStart = 0;

  $("item").each((_, item) => {
    const $item = $(item);
    const title = cleanText($item.find("title").first().text());
    if (!title) {
      droppedNoTitle++;
      return;
    }
    const startDate = toUtcMidnightIso(
      $item.find("mec\\:startDate").first().text() || null,
    );
    const endDate =
      toUtcMidnightIso(
        $item.find("mec\\:endDate").first().text() || null,
      ) ?? startDate;
    if (!startDate || !endDate) {
      droppedNoStart++;
      return;
    }

    const link = $item.find("link").first().text().trim() || null;
    const description = cleanDescription(
      $item.find("description").first().text(),
    );
    const locationRaw = cleanText(
      $item.find("mec\\:location").first().text(),
    );
    const organiser =
      cleanText($item.find("dc\\:creator").first().text()) ||
      "pilot-frank.de";

    // ICAO from mec:location takes priority. As a fallback we ONLY
    // accept an ICAO from the title when it's wrapped in parens
    // ("(EDGB)") — extractIcaoFromVenue's inline /\b[A-Z]{4}\b/ match
    // produces false positives on short uppercase words like "AERO"
    // or "ROCK" that frequently appear in this source's event titles.
    const fromLocation = locationRaw
      ? extractIcaoFromVenue(locationRaw)
      : { name: "", icao: null };
    const venueName = fromLocation.name;
    let icao = fromLocation.icao;
    if (!icao) {
      const explicit = title.match(/\(\s*([A-Z]{4})\s*\)/);
      if (explicit) icao = explicit[1];
    }
    const city = extractCityFromVenue(locationRaw);

    const idHash = sha1Short(
      `${title}|${startDate.slice(0, 10)}|${organiser}`,
    );
    const sourceUrl = link ?? `${pageUrl}#${idHash}`;

    out.push({
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl,
      sourceCategoryId: 0,
      categoryCode: classifyCategory(title),
      title,
      subtitle: null,
      dateRangeText: null,
      startDate,
      endDate,
      timezone: "Europe/Berlin",
      country: "DE",
      city,
      venueName: venueName || locationRaw || title,
      icaoCode: icao,
      organizerName: organiser,
      description,
      eventUrl: link,
      sourceLocale: "de",
      latitude: null,
      longitude: null,
    });
  });

  if (droppedNoTitle > 0 || droppedNoStart > 0) {
    logger.warn("pilot-frank parser dropped items", {
      pageUrl,
      droppedNoTitle,
      droppedNoStart,
      kept: out.length,
    });
  }
  return out;
}
