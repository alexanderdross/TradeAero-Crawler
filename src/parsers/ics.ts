import { createHash } from "node:crypto";
import {
  parseIcs,
  expandRrule,
  looksLikeIcalendar,
  type IcsEvent,
} from "../utils/ics.js";
import { cleanText } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import type { ParsedEvent } from "../types.js";
import type { IcsCalendar } from "../config.js";

/** Horizon for RRULE expansion: 90 days from the run start. Tunable
 *  if a specific feed needs longer reach. */
const RRULE_HORIZON_DAYS = 90;

// ─────────────────────────────────────────────────────────────────────────────
// ICS-feed parser.
//
// Each ICS calendar in config.sources.ics.calendars has its own metadata
// (default category, country, source language, organiser fallback). The
// parser threads those into ParsedEvent so the upsert pipeline gets a
// consistent shape regardless of feed quirks.
//
// Category mapping policy:
//   1. CATEGORIES line in the ICS event — match against event_categories.code
//   2. Fallback to calendar.defaultCategory
//
// (1) keeps publisher intent when they tag rigorously; (2) covers the
// long tail of feeds that just dump everything in.
// ─────────────────────────────────────────────────────────────────────────────

/** Recognised event_categories.code values. Mirrors the migration. */
const VALID_CATEGORY_CODES = new Set([
  "seminar",
  "competition",
  "flying-camp",
  "airfield-festival",
  "trade-fair",
  "airshow",
  "auction",
  "webinar",
  "meetup",
  "general",
]);

function pickCategoryCode(
  ics: IcsEvent,
  defaultCode: string,
): string {
  for (const c of ics.categories) {
    const norm = c.toLowerCase().replace(/\s+/g, "-");
    if (VALID_CATEGORY_CODES.has(norm)) return norm;
  }
  return VALID_CATEGORY_CODES.has(defaultCode) ? defaultCode : "general";
}

function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Best-effort split of a free-text LOCATION into venue + city. ICS feeds
 *  put everything in one field; we keep the original string as venue and
 *  pull the last comma-separated chunk as city when present. */
function extractCity(location: string): { venue: string; city: string | null } {
  const v = cleanText(location);
  if (!v) return { venue: "", city: null };
  // "Venue Name, 12345 City, Country" — pull "City" out.
  const postal = v.match(/\b\d{4,5}\s+([A-Za-zÄÖÜäöüßÉÈÊÀÂÇéèêàâç\s'-]+)/);
  if (postal) return { venue: v, city: postal[1].trim() };
  const parts = v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { venue: parts[0], city: parts[1] };
  return { venue: v, city: null };
}

/** Strip a trailing ICAO `(EDXX)` from venue text, returning both. */
function extractIcao(text: string): { name: string; icao: string | null } {
  const t = text.trim();
  const m = t.match(/^(.*?)\s*\(\s*([A-Z]{4})\s*\)\s*$/);
  if (m) return { name: m[1].trim(), icao: m[2] };
  const inline = t.match(/\b([A-Z]{4})\b/);
  if (inline)
    return {
      name: t.replace(inline[0], "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim(),
      icao: inline[1],
    };
  return { name: t, icao: null };
}

export function parseIcsCalendar(
  icsText: string,
  calendar: IcsCalendar,
  sourceName: string,
): ParsedEvent[] {
  // Sanity-check the payload BEFORE running the full parser. Some
  // hosts return a 200 with an HTML error / login wall / sign-up
  // gate when the ICS path is blocked or unauthorised; without this
  // guard we'd silently produce 0 events. The crawler-level "0 events
  // parsed" warning still fires for genuinely empty calendars.
  if (!looksLikeIcalendar(icsText)) {
    logger.warn("ICS payload doesn't start with BEGIN:VCALENDAR — feed may be blocked or returning HTML", {
      calendar: calendar.name,
      url: calendar.url,
      preview: icsText.slice(0, 80),
    });
    return [];
  }

  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + RRULE_HORIZON_DAYS);

  // `parseIcs` returns one row per VEVENT; expand recurring events
  // here so each occurrence becomes a row in `aviation_events` with
  // its own dedup key (sha1(title|start|organizer)). Bounded to the
  // 90-day horizon to keep weekly clubs from generating thousands of
  // far-future rows.
  const baseEvents = parseIcs(icsText);
  const events: IcsEvent[] = [];
  let expandedRecurrences = 0;
  for (const ev of baseEvents) {
    if (ev.rrule || ev.rdates.length > 0) {
      const occurrences = expandRrule(ev, horizon);
      events.push(...occurrences);
      if (occurrences.length > 1) expandedRecurrences += occurrences.length - 1;
    } else {
      events.push(ev);
    }
  }
  if (expandedRecurrences > 0) {
    logger.debug("Expanded recurring ICS events", {
      calendar: calendar.name,
      extraOccurrences: expandedRecurrences,
      horizonDays: RRULE_HORIZON_DAYS,
    });
  }

  const out: ParsedEvent[] = [];
  let droppedNoSummary = 0;
  let droppedNoStart = 0;
  let droppedCancelled = 0;
  for (const ev of events) {
    // Drop rows missing required fields, but log enough context so a
    // structurally-broken feed is visible in the run summary instead of
    // silently producing a 0-event crawl.
    //
    // UID-less events are intentionally **kept**: our dedup key is
    // sha1(title|startDay|organiser), synthesised below — we never
    // read `ev.uid`. Many smaller calendar exporters omit UID, and
    // rejecting them would drop legitimate events for no benefit.
    if (!ev.summary) {
      droppedNoSummary++;
      continue;
    }
    if (!ev.startIso) {
      droppedNoStart++;
      continue;
    }
    // RFC 5545 §3.8.1.11 STATUS=CANCELLED — feed publishers leave the
    // VEVENT in the payload (so subscribers reconcile it) but expect
    // consumers to filter. Drop without warning.
    if (ev.status === "CANCELLED") {
      droppedCancelled++;
      continue;
    }

    const { venue, city } = extractCity(ev.location);
    const { name: venueName, icao } = extractIcao(venue);

    const categoryCode = pickCategoryCode(ev, calendar.defaultCategory);

    // Stable dedup key: hash on the calendar-day component of startIso
    // rather than the full instant. A feed that flips the same event
    // between VALUE=DATE (all-day) and a timed VALUE=DATE-TIME would
    // otherwise produce two rows because the seconds-precision string
    // differs ("2026-04-25T00:00:00.000Z" vs "2026-04-25T18:00:00.000Z").
    // Day-precision still gives every recurring expansion its own hash
    // because expanded occurrences land on different days. Same
    // construction style as Vereinsflieger; both sources can share the
    // partial UNIQUE INDEX.
    const startDay = ev.startIso.slice(0, 10);
    const sourceIdHash = sha1Short(
      `${ev.summary}|${startDay}|${calendar.organiserName ?? calendar.name}`,
    );
    const sourceUrl = `${calendar.url}#${sourceIdHash}`;

    out.push({
      sourceId: sourceUrl,
      sourceUrl,
      sourceName,
      pageUrl: calendar.url,
      // Vereinsflieger-shaped audit fields — ICS feeds have no native
      // numeric category, so we leave the source id as 0.
      sourceCategoryId: 0,
      categoryCode,
      title: cleanText(ev.summary),
      subtitle: null,
      dateRangeText: null,
      startDate: ev.startIso,
      endDate: ev.endIso,
      timezone: ev.tzid ?? calendar.timezone ?? "Europe/Berlin",
      country: calendar.country,
      city,
      venueName: venueName || calendar.name,
      icaoCode: icao,
      organizerName: calendar.organiserName ?? calendar.name,
      description: ev.description ? cleanText(ev.description) : null,
      eventUrl: ev.url,
      sourceLocale: calendar.sourceLocale ?? "en",
      latitude: null,
      longitude: null,
    });
  }
  if (droppedNoSummary > 0 || droppedNoStart > 0 || droppedCancelled > 0) {
    logger.warn("ICS parser dropped events", {
      calendar: calendar.name,
      url: calendar.url,
      droppedNoSummary,
      droppedNoStart,
      droppedCancelled,
      kept: out.length,
    });
  }
  return out;
}
