import { describe, it, expect } from "vitest";
import { parseUlforumPage } from "../parsers/ulforum.js";

const PAGE_URL = "https://www.ulforum.de/veranstaltungen";
const SOURCE = "ulforum.de";

const eventBlock = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    "@context": "http://schema.org",
    "@type": "Event",
    name: "Currywurst Fly-In Hodenhagen 2026",
    eventStatus: "https://schema.org/EventScheduled",
    startDate: "2026-05-01",
    endDate: "2026-05-01",
    location: {
      "@type": "Place",
      name: "Flugplatz Hodenhagen (EDVH)",
      address: "Flugplatz Hodenhagen (EDVH)",
    },
    organizer: { "@type": "Person", name: "Aero-Club Hodenhagen", url: "" },
    offers: {
      url: "https://www.ulforum.de/veranstaltungen/288_currywurst-fly-in-hodenhagen-2026.html",
    },
    ...overrides,
  });

const wrap = (...blocks: string[]) =>
  blocks
    .map((b) => `<script type="application/ld+json">${b}</script>`)
    .join("\n");

describe("parseUlforumPage", () => {
  it("returns [] on a page with no JSON-LD", () => {
    expect(parseUlforumPage("<html></html>", PAGE_URL, SOURCE)).toEqual([]);
  });

  it("parses a single Schema.org Event row", () => {
    const events = parseUlforumPage(wrap(eventBlock()), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe("Currywurst Fly-In Hodenhagen 2026");
    expect(e.startDate).toBe("2026-05-01T00:00:00.000Z");
    expect(e.endDate).toBe("2026-05-01T00:00:00.000Z");
    expect(e.icaoCode).toBe("EDVH");
    expect(e.venueName).toBe("Flugplatz Hodenhagen");
    expect(e.organizerName).toBe("Aero-Club Hodenhagen");
    expect(e.country).toBe("DE");
    expect(e.categoryCode).toBe("meetup");
    // sourceUrl prefers the canonical offers.url so the partial UNIQUE
    // index dedups across crawls without depending on the page anchor.
    expect(e.sourceUrl).toBe(
      "https://www.ulforum.de/veranstaltungen/288_currywurst-fly-in-hodenhagen-2026.html",
    );
  });

  it("classifies airshow / competition / seminar by title keyword", () => {
    const events = parseUlforumPage(
      wrap(
        eventBlock({ name: "Tannkosh Flugtage 2026" }),
        eventBlock({ name: "DM Streckenflug Wettbewerb 2026" }),
        eventBlock({ name: "UL-Fortbildung Schmallenberg" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events.map((e) => e.categoryCode)).toEqual([
      "airshow",
      "competition",
      "seminar",
    ]);
  });

  it("drops cancelled events silently", () => {
    const events = parseUlforumPage(
      wrap(
        eventBlock({
          name: "Cancelled Fly-In",
          eventStatus: "https://schema.org/EventCancelled",
        }),
        eventBlock(),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Currywurst Fly-In Hodenhagen 2026");
  });

  it("falls back to pageUrl#hash when offers.url is missing", () => {
    const ev = JSON.parse(eventBlock()) as Record<string, unknown>;
    delete ev.offers;
    const events = parseUlforumPage(
      wrap(JSON.stringify(ev)),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].sourceUrl).toMatch(
      /^https:\/\/www\.ulforum\.de\/veranstaltungen#[a-f0-9]{16}$/,
    );
  });

  it("parses an array of events inside a single JSON-LD block", () => {
    const arr = JSON.stringify([
      JSON.parse(eventBlock()),
      JSON.parse(eventBlock({ name: "Hangar Talk", startDate: "2026-06-15" })),
    ]);
    const events = parseUlforumPage(
      `<script type="application/ld+json">${arr}</script>`,
      PAGE_URL,
      SOURCE,
    );
    expect(events).toHaveLength(2);
  });

  it("ignores non-Event JSON-LD blocks (e.g. BreadcrumbList)", () => {
    const breadcrumb = JSON.stringify({
      "@context": "http://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [],
    });
    const events = parseUlforumPage(
      wrap(breadcrumb, eventBlock()),
      PAGE_URL,
      SOURCE,
    );
    expect(events).toHaveLength(1);
  });

  it("uses startDate as endDate when endDate is missing", () => {
    const ev = JSON.parse(eventBlock()) as Record<string, unknown>;
    delete ev.endDate;
    const events = parseUlforumPage(
      wrap(JSON.stringify(ev)),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].endDate).toBe(events[0].startDate);
  });

  it("emits stable sourceUrl on identical input", () => {
    const a = parseUlforumPage(wrap(eventBlock()), PAGE_URL, SOURCE);
    const b = parseUlforumPage(wrap(eventBlock()), PAGE_URL, SOURCE);
    expect(a[0].sourceUrl).toEqual(b[0].sourceUrl);
  });
});
