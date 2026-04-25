// ─────────────────────────────────────────────────────────────────────────────
// Minimal RFC 5545 (iCalendar) parser.
//
// Built specifically for the events pipeline — we read SUMMARY,
// DESCRIPTION, DTSTART, DTEND, LOCATION, UID, URL, CATEGORIES out of
// VEVENT blocks and ignore everything else (VTODO, VJOURNAL, VALARM,
// VFREEBUSY, RRULE recurrence expansion, attachments, attendees, …).
//
// Why hand-rolled instead of `node-ical`?
//   - node-ical pulls a heavy regex-based parser + tz database + cron
//     parsing for RRULE expansion. We only need single-shot fields;
//     paying ~1 MB of deps for that is a poor trade.
//   - We control the bug surface — RFC 5545's edge cases (line folding,
//     escape sequences, TZID-prefixed dates) are well-defined and small.
//
// What this DOES handle:
//   - Line unfolding (RFC 5545 §3.1: continuation = CRLF + space/tab)
//   - Property-parameter parsing (`DTSTART;TZID=Europe/Berlin:20260424T100000`)
//   - Date/time decoding for the three RFC 5545 forms:
//       1. DATE        — `YYYYMMDD`
//       2. DATE-TIME UTC — `YYYYMMDDTHHmmssZ`
//       3. DATE-TIME local with TZID — `YYYYMMDDTHHmmss` (assumed Europe/Berlin
//          if the property has no TZID — sane default for the EU aviation
//          orgs we target)
//   - Escape decoding (`\n` → newline, `\\` → `\`, `\,` → `,`, `\;` → `;`)
//
// What this does NOT handle (out of scope for v1):
//   - RRULE / RDATE recurrence expansion (would multiply event counts —
//     punt to the upsert layer until we see real demand)
//   - VTIMEZONE custom rules — we trust the TZID name only
//   - VALARM, ATTENDEE, X-APPLE-* extensions
// ─────────────────────────────────────────────────────────────────────────────

export interface IcsEvent {
  /** `UID:` value (RFC 5545 mandatory). Used for dedup. */
  uid: string;
  /** `SUMMARY:` value (the title). */
  summary: string;
  /** `DESCRIPTION:` value, escape-decoded. May be empty. */
  description: string;
  /** ISO 8601 UTC string for the start instant. */
  startIso: string;
  /** ISO 8601 UTC string for the end instant. Falls back to start when
   *  the source omits DTEND (single-instant events). */
  endIso: string;
  /** Original DTSTART value's TZID parameter (if any). Useful for the
   *  caller's `timezone` field. */
  tzid: string | null;
  /** `LOCATION:` value, escape-decoded. */
  location: string;
  /** `URL:` value, if present. */
  url: string | null;
  /** Lowercase split of `CATEGORIES:` — used for category mapping. */
  categories: string[];
  /** Raw `RRULE:` value (e.g. `FREQ=WEEKLY;BYDAY=TU;UNTIL=20271231T000000Z`).
   *  Captured for the bounded expander in `expandRrule()`; null when
   *  the event isn't recurring. */
  rrule: string | null;
}

/**
 * Unfold continuation lines per RFC 5545 §3.1.
 *
 * iCalendar wraps long property values to ≤75 octets by inserting
 * CRLF + whitespace; reassembly strips the CRLF + leading whitespace.
 */
function unfold(input: string): string {
  // Normalise line endings then merge `(\r?\n)[ \t]` continuations.
  const lf = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lf.replace(/\n[ \t]/g, "");
}

/** Decode RFC 5545 §3.3.11 escape sequences in a value string. */
function decodeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

interface RawProperty {
  /** Property name (e.g. `DTSTART`). Always upper-cased. */
  name: string;
  /** Parameter map (e.g. `{ TZID: "Europe/Berlin", VALUE: "DATE" }`). */
  params: Record<string, string>;
  /** Raw value, escape-decoded. */
  value: string;
}

/**
 * Split a single iCalendar content line into name, params, value.
 *
 * Format:  NAME[;PARAM=val[;PARAM=val]*]:VALUE
 */
function parseLine(line: string): RawProperty | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = head.split(";");
  const name = segments[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf("=");
    if (eq < 0) continue;
    const k = segments[i].slice(0, eq).toUpperCase();
    let v = segments[i].slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { name, params, value: decodeText(value) };
}

/** Parse an iCalendar DATE / DATE-TIME value into an ISO 8601 UTC string.
 *
 *  - `YYYYMMDD`        → midnight UTC of that calendar day
 *  - `YYYYMMDDTHHmmssZ` → exact UTC instant
 *  - `YYYYMMDDTHHmmss`  → "floating" or TZID-bound; we treat it as the
 *                         supplied TZID when present, else Europe/Berlin
 *                         (heuristic biased to the EU aviation universe).
 *
 *  Returns null on unparseable input — the caller drops the event.
 */
function parseIcsDate(value: string, tzid: string | null): string | null {
  const v = value.trim();
  // DATE
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  // DATE-TIME UTC (`...Z` suffix)
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(
      Date.UTC(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
      ),
    );
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  // DATE-TIME local — interpret with TZID if known, else assume Europe/Berlin.
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const tz = tzid ?? "Europe/Berlin";
    // Construct "YYYY-MM-DDTHH:mm:ss" in the named timezone via Intl
    // tricks. Fast enough for our volumes (≤ a few thousand events/run).
    const isoLocal = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    const utcMs = zonedTimeToUtc(isoLocal, tz);
    if (utcMs == null) return null;
    return new Date(utcMs).toISOString();
  }
  return null;
}

/**
 * Convert a "floating" wall-clock string + IANA tz to a UTC ms timestamp.
 *
 * Pure JS (no luxon/date-fns-tz dep). Works by: parse as if UTC, then
 * compute the offset of the named tz at that instant by formatting back
 * via Intl.DateTimeFormat, and subtract. Approximate but accurate enough
 * for whole-minute precision (which is all RFC 5545 carries).
 */
function zonedTimeToUtc(isoLocal: string, tz: string): number | null {
  const tentative = new Date(`${isoLocal}Z`).getTime();
  if (Number.isNaN(tentative)) return null;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(tentative));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const tzMs = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    const offsetMs = tzMs - tentative;
    return tentative - offsetMs;
  } catch {
    // Unknown tz — fall back to treating the value as UTC.
    return tentative;
  }
}

/**
 * Parse a full iCalendar payload into an array of single-occurrence
 * events. Multi-day events are returned as one row spanning DTSTART→DTEND
 * (we do not expand RRULEs).
 */
export function parseIcs(input: string): IcsEvent[] {
  const lines = unfold(input).split("\n");
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> & { _dtstartTz?: string | null } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      current = {};
      continue;
    }
    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      if (current && current.uid && current.summary && current.startIso) {
        events.push({
          uid: current.uid,
          summary: current.summary,
          description: current.description ?? "",
          startIso: current.startIso,
          endIso: current.endIso ?? current.startIso,
          tzid: current._dtstartTz ?? null,
          location: current.location ?? "",
          url: current.url ?? null,
          categories: current.categories ?? [],
          rrule: current.rrule ?? null,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    switch (prop.name) {
      case "UID":
        current.uid = prop.value;
        break;
      case "SUMMARY":
        current.summary = prop.value;
        break;
      case "DESCRIPTION":
        current.description = prop.value;
        break;
      case "LOCATION":
        current.location = prop.value;
        break;
      case "URL":
        current.url = prop.value;
        break;
      case "CATEGORIES":
        current.categories = prop.value
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);
        break;
      case "DTSTART": {
        const tzid = prop.params.TZID ?? null;
        const iso = parseIcsDate(prop.value, tzid);
        if (iso) {
          current.startIso = iso;
          current._dtstartTz = tzid;
        }
        break;
      }
      case "DTEND": {
        const tzid = prop.params.TZID ?? null;
        const iso = parseIcsDate(prop.value, tzid);
        if (iso) current.endIso = iso;
        break;
      }
      case "RRULE":
        current.rrule = prop.value;
        break;
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded RRULE expansion.
//
// Handles the common subset of RFC 5545 §3.3.10 used by aviation club
// calendars: FREQ=DAILY|WEEKLY|MONTHLY, optional INTERVAL, optional
// COUNT, optional UNTIL, optional BYDAY for WEEKLY (e.g. "every Tu").
// Out-of-scope cases (BYSETPOS, BYMONTH, BYMONTHDAY without FREQ
// constraints, hourly/minutely/secondly, exception dates) fall back
// to "first occurrence only" — matches the previous behaviour, never
// regresses.
//
// Capped at `maxOccurrences` (default 26) AND the configured horizon
// (default 90 days from `now`) so a malformed UNTIL/COUNT can't
// expand into thousands of rows.
// ─────────────────────────────────────────────────────────────────────────────

interface RruleParts {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | null;
  interval: number;
  count: number | null;
  until: Date | null;
  byday: string[]; // e.g. ["MO","WE","FR"]
}

function parseRruleString(rrule: string): RruleParts {
  const parts: RruleParts = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: [],
  };
  for (const piece of rrule.split(";")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).toUpperCase();
    const value = piece.slice(eq + 1);
    switch (key) {
      case "FREQ": {
        const f = value.toUpperCase();
        if (f === "DAILY" || f === "WEEKLY" || f === "MONTHLY") {
          parts.freq = f;
        }
        break;
      }
      case "INTERVAL": {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) parts.interval = n;
        break;
      }
      case "COUNT": {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) parts.count = n;
        break;
      }
      case "UNTIL": {
        // RFC 5545 UNTIL is YYYYMMDD or YYYYMMDDTHHMMSSZ. Reuse the
        // existing parser which yields ISO 8601.
        const iso = parseIcsDate(value, null);
        if (iso) parts.until = new Date(iso);
        break;
      }
      case "BYDAY":
        parts.byday = value
          .split(",")
          .map((d) => d.trim().toUpperCase())
          .filter((d) => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(d));
        break;
    }
  }
  return parts;
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Expand a recurring `IcsEvent` into a series of single-occurrence
 * events bounded by a horizon. The base event is always the first
 * member of the returned array.
 *
 * @param event   The parsed VEVENT carrying an `rrule` value.
 * @param horizon Latest occurrence start to consider. Past-the-horizon
 *                instances are dropped without expanding further.
 * @param maxOccurrences Hard cap regardless of the rule. Defaults to
 *                26 — covers a year of weekly meetings without
 *                producing unbounded fan-out.
 */
export function expandRrule(
  event: IcsEvent,
  horizon: Date,
  maxOccurrences: number = 26,
): IcsEvent[] {
  const base = [{ ...event }];
  if (!event.rrule) return base;

  const rule = parseRruleString(event.rrule);
  if (!rule.freq) return base;

  const start = new Date(event.startIso);
  const end = new Date(event.endIso);
  if (!Number.isFinite(start.getTime())) return base;
  const durationMs = Math.max(0, end.getTime() - start.getTime());

  const out: IcsEvent[] = [event];
  const stopAt = rule.until && rule.until < horizon ? rule.until : horizon;

  if (rule.freq === "WEEKLY" && rule.byday.length > 0) {
    // Iterate week-by-week, emit each requested weekday.
    const weekdayIndices = rule.byday
      .map((d) => WEEKDAY_TO_INDEX[d])
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    let weekStart = new Date(start);
    // Anchor weekStart to the Sunday of the start's week (0).
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    while (out.length < maxOccurrences) {
      for (const wd of weekdayIndices) {
        const occurrence = new Date(weekStart);
        occurrence.setUTCDate(occurrence.getUTCDate() + wd);
        // Preserve the original time-of-day.
        occurrence.setUTCHours(
          start.getUTCHours(),
          start.getUTCMinutes(),
          start.getUTCSeconds(),
          0,
        );
        if (occurrence <= start) continue;
        if (occurrence > stopAt) return out;
        out.push({
          ...event,
          startIso: occurrence.toISOString(),
          endIso: new Date(occurrence.getTime() + durationMs).toISOString(),
        });
        if (out.length >= maxOccurrences) return out;
        if (rule.count && out.length >= rule.count) return out;
      }
      weekStart = new Date(weekStart);
      weekStart.setUTCDate(weekStart.getUTCDate() + 7 * rule.interval);
    }
    return out;
  }

  // Generic FREQ=DAILY/WEEKLY/MONTHLY without BYDAY: step from the
  // start date by `interval` units of the chosen frequency.
  let next = new Date(start);
  while (out.length < maxOccurrences) {
    if (rule.freq === "DAILY") {
      next = new Date(next);
      next.setUTCDate(next.getUTCDate() + rule.interval);
    } else if (rule.freq === "WEEKLY") {
      next = new Date(next);
      next.setUTCDate(next.getUTCDate() + 7 * rule.interval);
    } else {
      // MONTHLY
      next = new Date(next);
      next.setUTCMonth(next.getUTCMonth() + rule.interval);
    }
    if (next > stopAt) return out;
    out.push({
      ...event,
      startIso: next.toISOString(),
      endIso: new Date(next.getTime() + durationMs).toISOString(),
    });
    if (rule.count && out.length >= rule.count) return out;
  }
  return out;
}
