import { describe, it, expect } from "vitest";
import { validateEvent } from "../db/event-validation.js";
import type { ParsedEvent } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pre-upsert validation contract.
//
// Every rule below corresponds to a real failure mode observed during
// ICS / Vereinsflieger roll-out. If a rule changes, tests in this
// file pin the exact reason tag so admin-dashboard charts that break
// down dropped events by cause keep working.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-04-25T00:00:00.000Z");

function baseEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    sourceId: "https://example.com/cal.ics#abc",
    sourceUrl: "https://example.com/cal.ics#abc",
    sourceName: "ics-feed",
    pageUrl: "https://example.com/cal.ics",
    sourceCategoryId: 0,
    categoryCode: "meetup",
    title: "Annual Open Day",
    subtitle: null,
    dateRangeText: null,
    startDate: "2026-06-01T09:00:00.000Z",
    endDate: "2026-06-01T17:00:00.000Z",
    timezone: "Europe/Berlin",
    country: "DE",
    city: "Berlin",
    venueName: "Tempelhof",
    icaoCode: null,
    organizerName: "Test Org",
    description: null,
    eventUrl: null,
    sourceLocale: "en",
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

describe("validateEvent — happy path", () => {
  it("accepts a well-formed event", () => {
    expect(validateEvent(baseEvent(), NOW)).toEqual({ ok: true });
  });

  it("accepts a single-instant event (start === end)", () => {
    const ev = baseEvent({
      startDate: "2026-06-01T09:00:00.000Z",
      endDate: "2026-06-01T09:00:00.000Z",
    });
    expect(validateEvent(ev, NOW)).toEqual({ ok: true });
  });

  it("accepts a multi-day event up to MAX_DURATION_DAYS", () => {
    const ev = baseEvent({
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-08-30T00:00:00.000Z", // 90d
    });
    expect(validateEvent(ev, NOW)).toEqual({ ok: true });
  });
});

describe("validateEvent — title rules", () => {
  it("drops empty title", () => {
    expect(validateEvent(baseEvent({ title: "" }), NOW)).toEqual({
      ok: false,
      reason: "missing_title",
    });
  });

  it("drops whitespace-only title", () => {
    expect(validateEvent(baseEvent({ title: "   " }), NOW)).toEqual({
      ok: false,
      reason: "missing_title",
    });
  });

  it("drops title shorter than 3 chars", () => {
    expect(validateEvent(baseEvent({ title: "AT" }), NOW)).toEqual({
      ok: false,
      reason: "title_too_short",
    });
  });

  it("accepts a 3-char title (EAA)", () => {
    expect(validateEvent(baseEvent({ title: "EAA" }), NOW).ok).toBe(true);
  });
});

describe("validateEvent — required fields", () => {
  it("drops missing sourceUrl", () => {
    expect(validateEvent(baseEvent({ sourceUrl: "" }), NOW)).toEqual({
      ok: false,
      reason: "missing_source_url",
    });
  });

  it("drops missing categoryCode", () => {
    expect(validateEvent(baseEvent({ categoryCode: "" }), NOW)).toEqual({
      ok: false,
      reason: "missing_category",
    });
  });

  it("drops missing country", () => {
    expect(validateEvent(baseEvent({ country: "" }), NOW)).toEqual({
      ok: false,
      reason: "missing_country",
    });
  });
});

describe("validateEvent — date rules", () => {
  it("drops invalid startDate", () => {
    const ev = baseEvent({ startDate: "not-a-date" });
    expect(validateEvent(ev, NOW)).toEqual({
      ok: false,
      reason: "invalid_start_date",
    });
  });

  it("drops invalid endDate", () => {
    const ev = baseEvent({ endDate: "garbage" });
    expect(validateEvent(ev, NOW)).toEqual({
      ok: false,
      reason: "invalid_end_date",
    });
  });

  it("drops end before start", () => {
    const ev = baseEvent({
      startDate: "2026-06-02T00:00:00.000Z",
      endDate: "2026-06-01T00:00:00.000Z",
    });
    expect(validateEvent(ev, NOW)).toEqual({
      ok: false,
      reason: "end_before_start",
    });
  });

  it("drops duration > MAX_DURATION_DAYS", () => {
    const ev = baseEvent({
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-09-15T00:00:00.000Z", // 106d
    });
    expect(validateEvent(ev, NOW)).toEqual({
      ok: false,
      reason: "duration_exceeds_max",
    });
  });

  it("drops events that ended >90 days ago", () => {
    const ev = baseEvent({
      startDate: "2025-12-01T00:00:00.000Z",
      endDate: "2025-12-02T00:00:00.000Z", // 145d before NOW (2026-04-25)
    });
    expect(validateEvent(ev, NOW)).toEqual({
      ok: false,
      reason: "ended_too_long_ago",
    });
  });

  it("keeps events that ended within the past tolerance window", () => {
    const ev = baseEvent({
      startDate: "2026-03-01T00:00:00.000Z",
      endDate: "2026-03-02T00:00:00.000Z", // ~54d before NOW
    });
    expect(validateEvent(ev, NOW).ok).toBe(true);
  });

  it("drops events starting more than 5 years out", () => {
    const ev = baseEvent({
      startDate: "2032-01-01T00:00:00.000Z",
      endDate: "2032-01-02T00:00:00.000Z",
    });
    expect(validateEvent(ev, NOW)).toEqual({
      ok: false,
      reason: "starts_too_far_in_future",
    });
  });
});

describe("validateEvent — ICAO format", () => {
  it("accepts null icaoCode", () => {
    expect(validateEvent(baseEvent({ icaoCode: null }), NOW).ok).toBe(true);
  });

  it("accepts well-formed 4-letter ICAO", () => {
    expect(validateEvent(baseEvent({ icaoCode: "EDXX" }), NOW).ok).toBe(true);
  });

  it("drops 3-letter ICAO", () => {
    expect(validateEvent(baseEvent({ icaoCode: "ABC" }), NOW)).toEqual({
      ok: false,
      reason: "invalid_icao",
    });
  });

  it("drops mixed-case ICAO", () => {
    expect(validateEvent(baseEvent({ icaoCode: "Edxx" }), NOW)).toEqual({
      ok: false,
      reason: "invalid_icao",
    });
  });

  it("drops ICAO with embedded punctuation", () => {
    expect(validateEvent(baseEvent({ icaoCode: "ED-X" }), NOW)).toEqual({
      ok: false,
      reason: "invalid_icao",
    });
  });
});

describe("validateEvent — coordinates", () => {
  it("accepts null lat/lon", () => {
    expect(
      validateEvent(baseEvent({ latitude: null, longitude: null }), NOW).ok,
    ).toBe(true);
  });

  it("accepts lat/lon in range", () => {
    expect(
      validateEvent(baseEvent({ latitude: 52.5, longitude: 13.4 }), NOW).ok,
    ).toBe(true);
  });

  it("drops latitude out of range", () => {
    expect(
      validateEvent(baseEvent({ latitude: 180, longitude: 52.5 }), NOW),
    ).toEqual({ ok: false, reason: "invalid_coordinates" });
  });

  it("drops longitude out of range", () => {
    expect(
      validateEvent(baseEvent({ latitude: 52.5, longitude: 200 }), NOW),
    ).toEqual({ ok: false, reason: "invalid_coordinates" });
  });
});
