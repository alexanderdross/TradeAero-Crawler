import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { ParsedEvent } from "../types.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import { extractIcaoFromVenue, extractCityFromVenue } from "./vereinsflieger.js";

// ─────────────────────────────────────────────────────────────────────────────
// ulforum.de /veranstaltungen parser.
//
// Best-case input: each row is mirrored as a JSON-LD <script
// type="application/ld+json"> with @type=Event. Schema.org gives us
// startDate, endDate, location.name + location.address, organizer.name,
// and the canonical event URL via offers.url. Much cleaner than DOM
// scraping — we only fall back to DOM walking if JSON-LD ever
// disappears from the page.
// ─────────────────────────────────────────────────────────────────────────────

interface SchemaEvent {
  "@type"?: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  eventStatus?: string;
  location?: {
    name?: string;
    address?: string | { streetAddress?: string };
  };
  organizer?: { name?: string; url?: string };
  offers?: { url?: string };
  url?: string;
  description?: string;
}

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Coerce a YYYY-MM-DD or full ISO timestamp into a UTC midnight ISO. */
function toUtcMidnightIso(input: string | undefined): string | null {
  if (!input) return null;
  const day = input.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function pickOrganiser(ev: SchemaEvent): string {
  return ev.organizer?.name?.trim() || "ulforum.de";
}

function pickEventUrl(ev: SchemaEvent): string | null {
  return ev.offers?.url?.trim() || ev.url?.trim() || null;
}

function pickAddress(ev: SchemaEvent): string {
  const a = ev.location?.address;
  if (typeof a === "string") return a;
  return a?.streetAddress ?? "";
}

/** Map an ulforum event title → event_categories.code. The forum board
 *  badges most rows as "Fly-In" but the title text is more informative
 *  ("Pilotentreffen", "Schulung"). Default `meetup` matches the source's
 *  community-first character. */
function classifyCategory(title: string): string {
  const lc = title.toLowerCase();
  if (/airshow|flugshow|flugtag/.test(lc)) return "airshow";
  if (/wettbewerb|meisterschaft|cup\b/.test(lc)) return "competition";
  if (/seminar|fortbildung|schulung/.test(lc)) return "seminar";
  if (/messe|trade fair|expo\b/.test(lc)) return "trade-fair";
  if (/fly[-\s]?in|pilotentreffen|treffen/.test(lc)) return "meetup";
  return "meetup";
}

export function parseUlforumPage(
  html: string,
  pageUrl: string,
  sourceName: string,
): ParsedEvent[] {
  const $ = cheerio.load(html);
  const out: ParsedEvent[] = [];
  let droppedCancelled = 0;
  let droppedNoTitle = 0;
  let droppedNoStart = 0;

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.debug("ulforum JSON-LD parse error — skipping block", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const candidates: SchemaEvent[] = Array.isArray(parsed)
      ? (parsed as SchemaEvent[])
      : [parsed as SchemaEvent];
    for (const ev of candidates) {
      if (ev["@type"] !== "Event") continue;
      const title = cleanText(ev.name ?? "");
      if (!title) {
        droppedNoTitle++;
        continue;
      }
      // STATUS=CANCELLED → drop silently.
      if (ev.eventStatus?.includes("EventCancelled")) {
        droppedCancelled++;
        continue;
      }
      const startDate = toUtcMidnightIso(ev.startDate);
      const endDate = toUtcMidnightIso(ev.endDate) ?? startDate;
      if (!startDate || !endDate) {
        droppedNoStart++;
        continue;
      }
      const venueRaw = ev.location?.name ?? "";
      const address = pickAddress(ev);
      const { name: venueName, icao } = extractIcaoFromVenue(venueRaw);
      const city = extractCityFromVenue(address) ?? extractCityFromVenue(venueRaw);
      const eventUrl = pickEventUrl(ev);
      const organiser = pickOrganiser(ev);
      const category = classifyCategory(title);

      const idHash = sha1Short(`${title}|${startDate.slice(0, 10)}|${organiser}`);
      const sourceUrl = eventUrl
        ? eventUrl // ulforum's offers.url is already canonical + stable
        : `${pageUrl}#${idHash}`;

      out.push({
        sourceId: sourceUrl,
        sourceUrl,
        sourceName,
        pageUrl,
        sourceCategoryId: 0,
        categoryCode: category,
        title,
        subtitle: null,
        dateRangeText: null,
        startDate,
        endDate,
        timezone: "Europe/Berlin",
        country: "DE",
        city,
        venueName: venueName || "Unbekannt",
        icaoCode: icao,
        organizerName: organiser,
        description: ev.description ? cleanText(ev.description) : null,
        eventUrl,
        sourceLocale: "de",
        latitude: null,
        longitude: null,
      });
    }
  });

  if (droppedCancelled > 0 || droppedNoTitle > 0 || droppedNoStart > 0) {
    logger.warn("ulforum parser dropped events", {
      pageUrl,
      droppedCancelled,
      droppedNoTitle,
      droppedNoStart,
      kept: out.length,
    });
  }
  return out;
}
