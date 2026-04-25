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
  /** True when DTSTART is `VALUE=DATE` (date-only, no time-of-day).
   *  Lets the dedup key collapse all-day↔timed format flips so a feed
   *  that re-issues the same event in either form doesn't double-write. */
  isAllDay: boolean;
  /** ISO 8601 UTC strings of dates excluded from the recurrence (RFC
   *  5545 §3.8.5.1 EXDATE). The expander drops occurrences whose start
   *  matches any entry. Empty for non-recurring events. */
  exdates: string[];
  /** ISO 8601 UTC strings of additional occurrences appended to the
   *  recurrence (RFC 5545 §3.8.5.2 RDATE). Useful for one-off
   *  cancelled-then-rescheduled meetings or feed exporters that don't
   *  emit a clean RRULE. */
  rdates: string[];
  /** `STATUS:` value (CONFIRMED / CANCELLED / TENTATIVE). null when
   *  absent. The parser drops `CANCELLED` rows in `parseIcsCalendar`. */
  status: "CONFIRMED" | "CANCELLED" | "TENTATIVE" | null;
}

/**
 * Parse an RFC 5545 §3.8.2.5 DURATION value into milliseconds.
 *
 * Accepted forms (subset that real feeds emit):
 *   - `P1W`        — 1 week
 *   - `P1D`        — 1 day
 *   - `PT1H`       — 1 hour
 *   - `PT30M`      — 30 minutes
 *   - `PT15M`      — 15 minutes
 *   - `P1DT12H`    — 1 day 12 hours
 *   - `PT1H30M`    — composite time-only
 *   - `-PT15M`     — negative duration (rare, allowed in TRIGGER)
 *
 * Returns null on unparseable input. Used as a DTEND fallback when a
 * VEVENT carries DURATION instead of an explicit DTEND (Google
 * exports do this for all-day single events).
 */
export function parseIcsDuration(value: string): number | null {
  const m = value
    .trim()
    .match(
      /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
    );
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  if (!w && !d && !h && !mi && !s) return null;
  const seconds =
    Number(w ?? 0) * 7 * 24 * 60 * 60 +
    Number(d ?? 0) * 24 * 60 * 60 +
    Number(h ?? 0) * 60 * 60 +
    Number(mi ?? 0) * 60 +
    Number(s ?? 0);
  const ms = seconds * 1000;
  return sign === "-" ? -ms : ms;
}

/**
 * Rewrite `webcal://` and `webcals://` URL schemes to `https://`.
 *
 * `webcal://` is a calendar-subscription URL hint introduced by Apple
 * iCal (and adopted by Google / Microsoft); the actual transport is
 * plain HTTPS. Many event-page anchors use it so users get an
 * "Add to calendar" prompt. Our crawler fetches the same payload over
 * HTTPS — normalising at the edge means a config entry can copy-paste
 * the user-facing URL verbatim.
 *
 * Non-webcal URLs are returned unchanged.
 */
export function normalizeIcsUrl(url: string): string {
  return url.replace(/^webcals?:\/\//i, "https://");
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
 * Detect whether a payload is a recognisable iCalendar document.
 *
 * Used at the parser entry point + by the crawler to short-circuit
 * obvious non-iCal responses (host returns a 200 HTML "blocked"
 * page, login redirect, sign-up wall, …) instead of silently
 * producing 0 events. Cheap regex: BEGIN:VCALENDAR must be the
 * first non-whitespace content. Tolerates a UTF-8 BOM and leading
 * blank lines (some publishers add them) but rejects HTML payloads
 * that happen to contain the marker mid-stream.
 */
export function looksLikeIcalendar(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  // Strip optional UTF-8 BOM (U+FEFF) then any leading whitespace.
  // The BOM check uses charCodeAt rather than a regex literal so the
  // source stays ASCII-clean for ESLint's no-irregular-whitespace rule.
  let i = 0;
  if (input.charCodeAt(0) === 0xfeff) i = 1;
  const stripped = input.slice(i).trimStart();
  return /^BEGIN:VCALENDAR\b/i.test(stripped);
}

/**
 * Parse a full iCalendar payload into an array of single-occurrence
 * events. Multi-day events are returned as one row spanning DTSTART→DTEND
 * (we do not expand RRULEs).
 */
export function parseIcs(input: string): IcsEvent[] {
  const lines = unfold(input).split("\n");
  const events: IcsEvent[] = [];
  let current:
    | (Partial<IcsEvent> & {
        _dtstartTz?: string | null;
        _durationMs?: number | null;
      })
    | null = null;
  // Calendar-level fallback timezone. Many publishers (Google Calendar,
  // Outlook, the EAA chapter platform) emit `X-WR-TIMEZONE:America/New_York`
  // on the VCALENDAR and then leave individual VEVENT DTSTARTs as
  // floating local times. Without picking up the calendar default, we'd
  // mis-interpret those as Europe/Berlin and shift events by 6 hours.
  let calendarTzid: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const prop = parseLine(line);
    if (!prop) continue;

    // Capture VCALENDAR-level timezone hint. Must come BEFORE the first
    // VEVENT in well-formed payloads, but we tolerate mid-stream in
    // case a publisher emits it after BEGIN:VCALENDAR.
    if (
      !current &&
      prop.name === "X-WR-TIMEZONE" &&
      typeof prop.value === "string" &&
      prop.value.trim().length > 0
    ) {
      calendarTzid = prop.value.trim();
      continue;
    }

    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      current = {};
      continue;
    }
    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      if (current && current.uid && current.summary && current.startIso) {
        // Resolve endIso: prefer explicit DTEND, fall back to
        // DTSTART + DURATION, fall back to DTSTART (single-instant).
        let endIso = current.endIso;
        if (!endIso && current._durationMs != null) {
          const startMs = new Date(current.startIso).getTime();
          if (Number.isFinite(startMs)) {
            endIso = new Date(startMs + current._durationMs).toISOString();
          }
        }
        events.push({
          uid: current.uid,
          summary: current.summary,
          description: current.description ?? "",
          startIso: current.startIso,
          endIso: endIso ?? current.startIso,
          tzid: current._dtstartTz ?? null,
          location: current.location ?? "",
          url: current.url ?? null,
          categories: current.categories ?? [],
          rrule: current.rrule ?? null,
          isAllDay: current.isAllDay ?? false,
          exdates: current.exdates ?? [],
          rdates: current.rdates ?? [],
          status: current.status ?? null,
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
        // Per-property TZID wins; calendar-level X-WR-TIMEZONE is
        // the fallback for floating wall-clock values that have no
        // TZID parameter (Google Calendar exports look like this).
        const tzid = prop.params.TZID ?? calendarTzid;
        const iso = parseIcsDate(prop.value, tzid);
        if (iso) {
          current.startIso = iso;
          current._dtstartTz = tzid;
          // VALUE=DATE → all-day event (date-only DTSTART). The regex
          // fallback covers feeds that omit the parameter but emit a
          // bare YYYYMMDD value (Google export does this).
          current.isAllDay =
            prop.params.VALUE?.toUpperCase() === "DATE" ||
            /^\d{8}$/.test(prop.value.trim());
        }
        break;
      }
      case "DTEND": {
        const tzid = prop.params.TZID ?? calendarTzid;
        const iso = parseIcsDate(prop.value, tzid);
        if (iso) current.endIso = iso;
        break;
      }
      case "DURATION": {
        // Alternative to DTEND. Resolved against startIso below in a
        // post-pass — DURATION may appear before DTSTART in some
        // exports, so we stash the raw value and apply it once the
        // VEVENT closes.
        current._durationMs = parseIcsDuration(prop.value);
        break;
      }
      case "RRULE":
        current.rrule = prop.value;
        break;
      case "EXDATE": {
        // EXDATE may carry one or more comma-separated values, each
        // with the same DATE / DATE-TIME formats DTSTART accepts.
        const tzid = prop.params.TZID ?? calendarTzid;
        const list = current.exdates ?? [];
        for (const part of prop.value.split(",")) {
          const iso = parseIcsDate(part, tzid);
          if (iso) list.push(iso);
        }
        current.exdates = list;
        break;
      }
      case "RDATE": {
        // Mirrors EXDATE: explicit additional occurrences. Less common
        // than EXDATE but RFC 5545 supports both.
        const tzid = prop.params.TZID ?? calendarTzid;
        const list = current.rdates ?? [];
        for (const part of prop.value.split(",")) {
          const iso = parseIcsDate(part, tzid);
          if (iso) list.push(iso);
        }
        current.rdates = list;
        break;
      }
      case "STATUS": {
        const s = prop.value.trim().toUpperCase();
        if (s === "CONFIRMED" || s === "CANCELLED" || s === "TENTATIVE") {
          current.status = s;
        }
        break;
      }
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

/** A single BYDAY entry. `prefix=0` means "every <weekday> in the
 *  period" (the default for WEEKLY); non-zero means the Nth occurrence
 *  within the month (only meaningful for MONTHLY/YEARLY per RFC 5545). */
interface BydayEntry {
  prefix: number;
  weekday: "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
}

interface RruleParts {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | null;
  interval: number;
  count: number | null;
  until: Date | null;
  byday: BydayEntry[];
  bymonthday: number[]; // e.g. [1, 15] for "1st and 15th of every month"
}

function parseRruleString(rrule: string): RruleParts {
  const parts: RruleParts = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: [],
    bymonthday: [],
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
      case "BYDAY": {
        // Each entry is `[+-]?\d?WD` where WD ∈ {MO,TU,WE,TH,FR,SA,SU}.
        // No prefix → every matching weekday in the period; numeric
        // prefix → Nth occurrence (RFC 5545 §3.3.10, monthly/yearly only).
        const entries: BydayEntry[] = [];
        for (const piece of value.split(",")) {
          const m = piece.trim().toUpperCase().match(
            /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/,
          );
          if (!m) continue;
          const prefix = m[1] ? parseInt(m[1], 10) : 0;
          if (!Number.isFinite(prefix)) continue;
          entries.push({
            prefix,
            weekday: m[2] as BydayEntry["weekday"],
          });
        }
        parts.byday = entries;
        break;
      }
      case "BYMONTHDAY":
        parts.bymonthday = value
          .split(",")
          .map((d) => parseInt(d.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31);
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
 * Return the dates in (year, month) where `weekday` falls on the
 * `prefix`-th occurrence within the month.
 *
 *   - `prefix > 0` — Nth occurrence (1 = first, 2 = second, …)
 *   - `prefix < 0` — counted from the end (-1 = last, -2 = second-to-last)
 *   - `prefix === 0` — every occurrence of the weekday in the month
 *
 * Returns `[]` when prefix is out of range for the month (e.g. `5MO`
 * for a month that only has 4 Mondays).
 */
function nthWeekdaysOfMonth(
  year: number,
  month: number,
  weekday: number,
  prefix: number,
): Date[] {
  // Build the list of every matching weekday in the month.
  const all: Date[] = [];
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  for (let day = 1 + offset; day <= 31; day += 7) {
    const candidate = new Date(Date.UTC(year, month, day));
    if (candidate.getUTCMonth() !== month) break;
    all.push(candidate);
  }
  if (prefix === 0) return all;
  if (prefix > 0) {
    const idx = prefix - 1;
    return idx < all.length ? [all[idx]] : [];
  }
  const idx = all.length + prefix;
  return idx >= 0 ? [all[idx]] : [];
}

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
  const start = new Date(event.startIso);
  const end = new Date(event.endIso);
  const durationMs =
    Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())
      ? Math.max(0, end.getTime() - start.getTime())
      : 0;

  // EXDATE list as a Set of ISO strings for O(1) membership checks.
  const excluded = new Set(event.exdates);
  const isExcluded = (iso: string): boolean => excluded.has(iso);

  /** Append RDATE-supplied occurrences and return. Bounded by horizon
   *  + maxOccurrences. Used as the final pass for any expansion path
   *  AND as the only pass when an event has no RRULE. */
  const mergeRdates = (acc: IcsEvent[]): IcsEvent[] => {
    if (!event.rdates.length) return acc;
    const seen = new Set(acc.map((e) => e.startIso));
    const sorted = [...event.rdates].sort();
    for (const iso of sorted) {
      if (acc.length >= maxOccurrences) break;
      if (seen.has(iso)) continue;
      if (isExcluded(iso)) continue;
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) continue;
      if (d > horizon) continue;
      acc.push({
        ...event,
        startIso: iso,
        endIso: new Date(d.getTime() + durationMs).toISOString(),
      });
      seen.add(iso);
    }
    // Keep the output chronologically ordered for downstream callers.
    return acc.sort((a, b) =>
      a.startIso < b.startIso ? -1 : a.startIso > b.startIso ? 1 : 0,
    );
  };

  // Fast paths that skip RRULE expansion entirely.
  const baseOnly: IcsEvent[] = isExcluded(event.startIso) ? [] : [{ ...event }];
  if (!event.rrule) return mergeRdates(baseOnly);

  const rule = parseRruleString(event.rrule);
  if (!rule.freq) return mergeRdates(baseOnly);
  if (!Number.isFinite(start.getTime())) return mergeRdates(baseOnly);

  // Base occurrence is always emitted unless explicitly excluded.
  const out: IcsEvent[] = isExcluded(event.startIso) ? [] : [event];
  const stopAt = rule.until && rule.until < horizon ? rule.until : horizon;

  // RFC 5545 COUNT counts raw rule occurrences (including ones EXDATE
  // strips out); the published recurrence size is therefore COUNT
  // minus the matching EXDATEs. Track raw count separately from the
  // emitted-rows count so the budget is respected regardless of how
  // many EXDATEs land inside the window. The base counts as raw=1.
  let rawCount = 1;

  /** Push an occurrence unless it's listed in EXDATE; always
   *  increments the rawCount budget. Returns true when the loop
   *  should stop (COUNT hit, maxOccurrences hit, or out-of-horizon
   *  needs handling by the caller). */
  const emit = (occurrence: Date): boolean => {
    rawCount++;
    const startIso = occurrence.toISOString();
    if (!isExcluded(startIso)) {
      out.push({
        ...event,
        startIso,
        endIso: new Date(occurrence.getTime() + durationMs).toISOString(),
      });
      if (out.length >= maxOccurrences) return true;
    }
    if (rule.count && rawCount >= rule.count) return true;
    return false;
  };

  if (rule.freq === "WEEKLY" && rule.byday.length > 0) {
    // Iterate week-by-week, emit each requested weekday.
    // Positional prefixes (1MO, -1FR) aren't meaningful for FREQ=WEEKLY
    // per RFC 5545 — drop the prefix and use the weekday alone.
    const weekdayIndices = rule.byday
      .map((entry) => WEEKDAY_TO_INDEX[entry.weekday])
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
        if (occurrence > stopAt) return mergeRdates(out);
        if (emit(occurrence)) return mergeRdates(out);
      }
      weekStart = new Date(weekStart);
      weekStart.setUTCDate(weekStart.getUTCDate() + 7 * rule.interval);
    }
    return mergeRdates(out);
  }

  if (rule.freq === "MONTHLY" && rule.byday.length > 0) {
    // FREQ=MONTHLY;BYDAY=2WE → every month on the 2nd Wednesday.
    // BYDAY=WE (no prefix) → every Wednesday in every month.
    // BYDAY=-1FR → last Friday of every month.
    // Iterate month by month, compute the matching dates within each.
    let monthCursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
    );
    while (out.length < maxOccurrences) {
      const monthOccurrences: Date[] = [];
      for (const entry of rule.byday) {
        const wdIndex = WEEKDAY_TO_INDEX[entry.weekday];
        if (!Number.isFinite(wdIndex)) continue;
        const dates = nthWeekdaysOfMonth(
          monthCursor.getUTCFullYear(),
          monthCursor.getUTCMonth(),
          wdIndex,
          entry.prefix,
        );
        for (const d of dates) {
          d.setUTCHours(
            start.getUTCHours(),
            start.getUTCMinutes(),
            start.getUTCSeconds(),
            0,
          );
          monthOccurrences.push(d);
        }
      }
      // Process this month's hits in chronological order.
      monthOccurrences.sort((a, b) => a.getTime() - b.getTime());
      for (const occurrence of monthOccurrences) {
        if (occurrence <= start) continue;
        if (occurrence > stopAt) return mergeRdates(out);
        if (emit(occurrence)) return mergeRdates(out);
      }
      monthCursor = new Date(monthCursor);
      monthCursor.setUTCMonth(monthCursor.getUTCMonth() + rule.interval);
    }
    return mergeRdates(out);
  }

  if (rule.freq === "MONTHLY" && rule.bymonthday.length > 0) {
    // FREQ=MONTHLY;BYMONTHDAY=15 → every month on the 15th. Common for
    // EAA/AOPA chapter monthly meetings. Iterate month-by-month from the
    // start, emit every day in BYMONTHDAY that lands within stopAt.
    const sortedDays = [...rule.bymonthday].sort((a, b) => a - b);
    let monthCursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
    );
    while (out.length < maxOccurrences) {
      for (const day of sortedDays) {
        const occurrence = new Date(
          Date.UTC(
            monthCursor.getUTCFullYear(),
            monthCursor.getUTCMonth(),
            day,
            start.getUTCHours(),
            start.getUTCMinutes(),
            start.getUTCSeconds(),
          ),
        );
        // Skip days that don't exist in this month (e.g. day=31 in Feb)
        if (occurrence.getUTCMonth() !== monthCursor.getUTCMonth()) continue;
        if (occurrence <= start) continue;
        if (occurrence > stopAt) return mergeRdates(out);
        if (emit(occurrence)) return mergeRdates(out);
      }
      monthCursor = new Date(monthCursor);
      monthCursor.setUTCMonth(monthCursor.getUTCMonth() + rule.interval);
    }
    return mergeRdates(out);
  }

  // Generic FREQ=DAILY/WEEKLY/MONTHLY without BYDAY/BYMONTHDAY: step
  // from the start date by `interval` units of the chosen frequency.
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
    if (next > stopAt) return mergeRdates(out);
    if (emit(next)) return mergeRdates(out);
  }
  return mergeRdates(out);
}
