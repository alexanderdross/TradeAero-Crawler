import { describe, it, expect } from "vitest";
import {
  parseIcs,
  expandRrule,
  normalizeIcsUrl,
  type IcsEvent,
} from "../utils/ics.js";
import { parseIcsCalendar } from "../parsers/ics.js";
import type { IcsCalendar } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// ICS pipeline contract tests.
//
// Cover the recent hardening pass: webcal:// rewriting, all-day flag,
// EXDATE skipping, BYMONTHDAY recurrence, CANCELLED filtering, and the
// day-precision dedup hash. Each block pins a single behaviour so a
// regression points straight at the cause.
// ─────────────────────────────────────────────────────────────────────────────

const calendar: IcsCalendar = {
  name: "Test Club",
  url: "https://example.com/calendar.ics",
  country: "DE",
  defaultCategory: "meetup",
  organiserName: "Test Club Organiser",
};

function vevent(body: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Test//EN",
    "BEGIN:VEVENT",
    body,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("normalizeIcsUrl", () => {
  it("rewrites webcal:// to https://", () => {
    expect(normalizeIcsUrl("webcal://example.com/cal.ics")).toBe(
      "https://example.com/cal.ics",
    );
  });

  it("rewrites webcals:// to https://", () => {
    expect(normalizeIcsUrl("webcals://example.com/cal.ics")).toBe(
      "https://example.com/cal.ics",
    );
  });

  it("passes https:// through unchanged", () => {
    expect(normalizeIcsUrl("https://example.com/cal.ics")).toBe(
      "https://example.com/cal.ics",
    );
  });

  it("passes http:// through unchanged", () => {
    expect(normalizeIcsUrl("http://example.com/cal.ics")).toBe(
      "http://example.com/cal.ics",
    );
  });

  it("is case-insensitive on the scheme", () => {
    expect(normalizeIcsUrl("WEBCAL://example.com/cal.ics")).toBe(
      "https://example.com/cal.ics",
    );
  });
});

describe("parseIcs — all-day detection", () => {
  it("marks VALUE=DATE events as all-day", () => {
    const ics = vevent(
      [
        "UID:1",
        "SUMMARY:Open Day",
        "DTSTART;VALUE=DATE:20260601",
        "DTEND;VALUE=DATE:20260602",
      ].join("\r\n"),
    );
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0].isAllDay).toBe(true);
  });

  it("marks bare YYYYMMDD DTSTART as all-day even without VALUE=DATE", () => {
    const ics = vevent(
      ["UID:1", "SUMMARY:Open Day", "DTSTART:20260601"].join("\r\n"),
    );
    const events = parseIcs(ics);
    expect(events[0].isAllDay).toBe(true);
  });

  it("leaves timed events with isAllDay=false", () => {
    const ics = vevent(
      [
        "UID:1",
        "SUMMARY:Briefing",
        "DTSTART:20260601T090000Z",
        "DTEND:20260601T100000Z",
      ].join("\r\n"),
    );
    const events = parseIcs(ics);
    expect(events[0].isAllDay).toBe(false);
  });
});

describe("parseIcs — STATUS + EXDATE", () => {
  it("captures STATUS:CANCELLED on the event", () => {
    const ics = vevent(
      [
        "UID:1",
        "SUMMARY:Cancelled meet",
        "DTSTART:20260601T090000Z",
        "STATUS:CANCELLED",
      ].join("\r\n"),
    );
    expect(parseIcs(ics)[0].status).toBe("CANCELLED");
  });

  it("captures STATUS:CONFIRMED", () => {
    const ics = vevent(
      [
        "UID:1",
        "SUMMARY:Confirmed",
        "DTSTART:20260601T090000Z",
        "STATUS:CONFIRMED",
      ].join("\r\n"),
    );
    expect(parseIcs(ics)[0].status).toBe("CONFIRMED");
  });

  it("captures one EXDATE", () => {
    const ics = vevent(
      [
        "UID:1",
        "SUMMARY:Weekly",
        "DTSTART:20260601T090000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4",
        "EXDATE:20260615T090000Z",
      ].join("\r\n"),
    );
    const ev = parseIcs(ics)[0];
    expect(ev.exdates).toHaveLength(1);
    expect(ev.exdates[0]).toBe("2026-06-15T09:00:00.000Z");
  });

  it("captures multiple comma-separated EXDATEs", () => {
    const ics = vevent(
      [
        "UID:1",
        "SUMMARY:Weekly",
        "DTSTART:20260601T090000Z",
        "RRULE:FREQ=WEEKLY",
        "EXDATE:20260608T090000Z,20260615T090000Z",
      ].join("\r\n"),
    );
    expect(parseIcs(ics)[0].exdates).toHaveLength(2);
  });
});

function makeEvent(overrides: Partial<IcsEvent>): IcsEvent {
  return {
    uid: "1",
    summary: "Test",
    description: "",
    startIso: "2026-06-01T09:00:00.000Z",
    endIso: "2026-06-01T10:00:00.000Z",
    tzid: null,
    location: "",
    url: null,
    categories: [],
    rrule: null,
    isAllDay: false,
    exdates: [],
    status: null,
    ...overrides,
  };
}

describe("expandRrule — BYMONTHDAY", () => {
  it("emits one occurrence per month on the requested day", () => {
    const ev = makeEvent({
      startIso: "2026-01-15T09:00:00.000Z",
      endIso: "2026-01-15T10:00:00.000Z",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3",
    });
    const horizon = new Date("2027-01-01T00:00:00.000Z");
    const out = expandRrule(ev, horizon);
    expect(out).toHaveLength(3);
    expect(out[0].startIso).toBe("2026-01-15T09:00:00.000Z");
    expect(out[1].startIso).toBe("2026-02-15T09:00:00.000Z");
    expect(out[2].startIso).toBe("2026-03-15T09:00:00.000Z");
  });

  it("emits multiple days within each month when BYMONTHDAY has several values", () => {
    const ev = makeEvent({
      startIso: "2026-01-01T09:00:00.000Z",
      endIso: "2026-01-01T10:00:00.000Z",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=4",
    });
    const horizon = new Date("2027-01-01T00:00:00.000Z");
    const out = expandRrule(ev, horizon);
    expect(out).toHaveLength(4);
    expect(out[0].startIso).toBe("2026-01-01T09:00:00.000Z");
    expect(out[1].startIso).toBe("2026-01-15T09:00:00.000Z");
    expect(out[2].startIso).toBe("2026-02-01T09:00:00.000Z");
    expect(out[3].startIso).toBe("2026-02-15T09:00:00.000Z");
  });

  it("skips months that don't have the requested day (e.g. Feb 30)", () => {
    const ev = makeEvent({
      startIso: "2026-01-30T09:00:00.000Z",
      endIso: "2026-01-30T10:00:00.000Z",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=30;COUNT=4",
    });
    const horizon = new Date("2027-01-01T00:00:00.000Z");
    const out = expandRrule(ev, horizon);
    // Jan 30, Mar 30, Apr 30, May 30 — Feb skipped (no 30th)
    expect(out.map((o) => o.startIso)).toEqual([
      "2026-01-30T09:00:00.000Z",
      "2026-03-30T09:00:00.000Z",
      "2026-04-30T09:00:00.000Z",
      "2026-05-30T09:00:00.000Z",
    ]);
  });

  it("respects the horizon", () => {
    const ev = makeEvent({
      startIso: "2026-01-15T09:00:00.000Z",
      endIso: "2026-01-15T10:00:00.000Z",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15",
    });
    const horizon = new Date("2026-04-01T00:00:00.000Z");
    const out = expandRrule(ev, horizon);
    // Jan, Feb, Mar — Apr is beyond horizon (Apr 15 > Apr 1).
    expect(out).toHaveLength(3);
  });
});

describe("expandRrule — EXDATE filtering", () => {
  it("drops occurrences whose start matches an EXDATE", () => {
    const ev = makeEvent({
      startIso: "2026-06-01T09:00:00.000Z",
      endIso: "2026-06-01T10:00:00.000Z",
      rrule: "FREQ=WEEKLY;COUNT=4",
      exdates: ["2026-06-15T09:00:00.000Z"],
    });
    const horizon = new Date("2027-01-01T00:00:00.000Z");
    const out = expandRrule(ev, horizon);
    // Base + 3 weeks (2nd/3rd/4th) minus the excluded 3rd → 3 events.
    expect(out.map((o) => o.startIso)).toEqual([
      "2026-06-01T09:00:00.000Z",
      "2026-06-08T09:00:00.000Z",
      "2026-06-22T09:00:00.000Z",
    ]);
  });

  it("drops the base occurrence if its start is on an EXDATE", () => {
    const ev = makeEvent({
      startIso: "2026-06-01T09:00:00.000Z",
      endIso: "2026-06-01T10:00:00.000Z",
      rrule: "FREQ=WEEKLY;COUNT=2",
      exdates: ["2026-06-01T09:00:00.000Z"],
    });
    const horizon = new Date("2027-01-01T00:00:00.000Z");
    const out = expandRrule(ev, horizon);
    expect(out.map((o) => o.startIso)).toEqual(["2026-06-08T09:00:00.000Z"]);
  });
});

describe("parseIcsCalendar — drops cancelled, day-precision dedup", () => {
  it("drops STATUS:CANCELLED events", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "BEGIN:VEVENT",
      "UID:keep",
      "SUMMARY:Active Meet",
      "DTSTART:20260601T090000Z",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:drop",
      "SUMMARY:Cancelled Meet",
      "DTSTART:20260602T090000Z",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const out = parseIcsCalendar(ics, calendar, "ics-feed");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Active Meet");
  });

  it("produces the same sourceId for all-day and timed variants of the same event", () => {
    // A feed that publishes the same event as VALUE=DATE one run and
    // as a timed VALUE=DATE-TIME the next would otherwise create two
    // rows. Day-precision hashing collapses them.
    const allDay = vevent(
      [
        "UID:1",
        "SUMMARY:Open Day",
        "DTSTART;VALUE=DATE:20260601",
        "DTEND;VALUE=DATE:20260602",
      ].join("\r\n"),
    );
    const timed = vevent(
      [
        "UID:2",
        "SUMMARY:Open Day",
        "DTSTART:20260601T140000Z",
        "DTEND:20260601T180000Z",
      ].join("\r\n"),
    );
    const a = parseIcsCalendar(allDay, calendar, "ics-feed");
    const b = parseIcsCalendar(timed, calendar, "ics-feed");
    expect(a[0].sourceId).toBe(b[0].sourceId);
  });

  it("produces different sourceIds for different days even with same title", () => {
    const day1 = vevent(
      ["UID:1", "SUMMARY:Open Day", "DTSTART:20260601T090000Z"].join("\r\n"),
    );
    const day2 = vevent(
      ["UID:1", "SUMMARY:Open Day", "DTSTART:20260602T090000Z"].join("\r\n"),
    );
    const a = parseIcsCalendar(day1, calendar, "ics-feed");
    const b = parseIcsCalendar(day2, calendar, "ics-feed");
    expect(a[0].sourceId).not.toBe(b[0].sourceId);
  });
});
