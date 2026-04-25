import { describe, it, expect } from "vitest";
import {
  parseIataPage,
  parseIataDateRange,
  parseIataVenue,
  parseIataTotalPages,
} from "../parsers/iata.js";

const PAGE_URL = "https://www.iata.org/en/events/";
const SOURCE = "iata.org";

// Reference instant pinned to 2026-04-25 to make the year-rollover
// tests deterministic regardless of when the suite runs.
const NOW = new Date(Date.UTC(2026, 3, 25));

describe("parseIataDateRange", () => {
  it("parses a single-day card", () => {
    expect(parseIataDateRange("12 May", NOW)).toEqual({
      startDate: "2026-05-12T00:00:00.000Z",
      endDate: "2026-05-12T00:00:00.000Z",
    });
  });

  it("parses a same-month range", () => {
    expect(parseIataDateRange("12 - 14 May", NOW)).toEqual({
      startDate: "2026-05-12T00:00:00.000Z",
      endDate: "2026-05-14T00:00:00.000Z",
    });
  });

  it("parses a cross-month range", () => {
    expect(parseIataDateRange("28 Sep - 02 Oct", NOW)).toEqual({
      startDate: "2026-09-28T00:00:00.000Z",
      endDate: "2026-10-02T00:00:00.000Z",
    });
  });

  it("rolls over a past date to next year", () => {
    // Reference is 2026-04-25; "12 Mar" is over 30 days back so
    // it must land on 2027-03-12, not 2026-03-12.
    expect(parseIataDateRange("12 Mar", NOW)).toEqual({
      startDate: "2027-03-12T00:00:00.000Z",
      endDate: "2027-03-12T00:00:00.000Z",
    });
  });

  it("handles a Dec → Jan cross-year range", () => {
    expect(parseIataDateRange("28 Dec - 02 Jan", NOW)).toEqual({
      startDate: "2026-12-28T00:00:00.000Z",
      endDate: "2027-01-02T00:00:00.000Z",
    });
  });

  it("returns null on prose", () => {
    expect(parseIataDateRange("Coming soon", NOW)).toBeNull();
    expect(parseIataDateRange("", NOW)).toBeNull();
  });
});

describe("parseIataVenue", () => {
  it("parses 'City, Country'", () => {
    expect(parseIataVenue("Paris, France")).toEqual({
      city: "Paris",
      country: "FR",
    });
  });

  it("falls back to XX for unknown countries", () => {
    expect(parseIataVenue("Unknown Town, Vulcania")).toEqual({
      city: "Unknown Town",
      country: "XX",
    });
  });

  it("handles country-only strings", () => {
    expect(parseIataVenue("Singapore")).toEqual({
      city: null,
      country: "SG",
    });
  });

  it("handles multi-comma strings (takes last segment as country)", () => {
    expect(parseIataVenue("Mövenpick Hotel, Geneva, Switzerland")).toEqual({
      city: "Mövenpick Hotel",
      country: "CH",
    });
  });
});

describe("parseIataTotalPages", () => {
  it("returns 1 with no pagination", () => {
    expect(parseIataTotalPages("<html></html>")).toBe(1);
  });

  it("returns the highest page link", () => {
    const html = `
      <a href="?page=1">1</a>
      <a href="?page=2">2</a>
      <a href="?page=3">3</a>`;
    expect(parseIataTotalPages(html)).toBe(3);
  });

  it("caps absurd values at 20", () => {
    const html = `<a href="?page=99">99</a>`;
    expect(parseIataTotalPages(html)).toBe(20);
  });
});

describe("parseIataPage", () => {
  it("returns [] when there are no event cards", () => {
    expect(parseIataPage("<html></html>", PAGE_URL, SOURCE, NOW)).toEqual([]);
  });

  it("parses a typical event card", () => {
    const html = `
      <a class="global-event-list-item" href="/en/events/all/iata-aviation-energy-forum/">
        <img class="global-event-list-item-img" src="x.jpg" />
        <div class="global-event-list-item-content">
          <h4 class="global-event-list-title">Aviation Energy Forum (AEF)</h4>
          <div class="global-event-list-item-venue">Paris, France</div>
          <div class="global-event-list-item-date">12 - 14 May</div>
        </div>
      </a>`;
    const events = parseIataPage(html, PAGE_URL, SOURCE, NOW);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe("Aviation Energy Forum (AEF)");
    expect(e.startDate).toBe("2026-05-12T00:00:00.000Z");
    expect(e.endDate).toBe("2026-05-14T00:00:00.000Z");
    expect(e.country).toBe("FR");
    expect(e.city).toBe("Paris");
    expect(e.categoryCode).toBe("seminar"); // matches "forum"
    expect(e.organizerName).toBe("IATA");
    expect(e.eventUrl).toBe(
      "https://www.iata.org/en/events/all/iata-aviation-energy-forum/",
    );
    expect(e.sourceLocale).toBe("en");
  });

  it("classifies expo / conference / awards correctly", () => {
    const card = (title: string) => `
      <a class="global-event-list-item" href="/en/events/all/${encodeURIComponent(title)}/">
        <div class="global-event-list-item-content">
          <h4 class="global-event-list-title">${title}</h4>
          <div class="global-event-list-item-venue">Geneva, Switzerland</div>
          <div class="global-event-list-item-date">15 - 17 Jun</div>
        </div>
      </a>`;
    const events = parseIataPage(
      card("World Cargo Symposium") +
        card("Cabin Operations Conference") +
        card("World Sustainability Awards") +
        card("Aviation Tech Expo"),
      PAGE_URL,
      SOURCE,
      NOW,
    );
    expect(events.map((e) => e.categoryCode)).toEqual([
      "seminar",
      "seminar",
      "general",
      "trade-fair",
    ]);
  });

  it("absolutises relative hrefs to https://www.iata.org/...", () => {
    const html = `
      <a class="global-event-list-item" href="/en/events/all/x/">
        <h4 class="global-event-list-title">X</h4>
        <div class="global-event-list-item-venue">Singapore</div>
        <div class="global-event-list-item-date">12 May</div>
      </a>`;
    const events = parseIataPage(html, PAGE_URL, SOURCE, NOW);
    expect(events[0].sourceUrl).toBe("https://www.iata.org/en/events/all/x/");
  });

  it("skips cards with unparseable date strings", () => {
    const html = `
      <a class="global-event-list-item" href="/en/events/all/y/">
        <h4 class="global-event-list-title">Y</h4>
        <div class="global-event-list-item-venue">Madrid, Spain</div>
        <div class="global-event-list-item-date">Coming soon</div>
      </a>`;
    expect(parseIataPage(html, PAGE_URL, SOURCE, NOW)).toEqual([]);
  });
});
