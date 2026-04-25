import { describe, it, expect } from "vitest";
import { parseNbaaPage, parseNbaaDateRange } from "../parsers/nbaa.js";

const PAGE_URL = "https://nbaa.org/events/";
const SOURCE = "nbaa.org";

const card = (opts: {
  title?: string;
  href?: string;
  date?: string;
  location?: string;
  excerpt?: string;
} = {}) => {
  const {
    title = "NBAA Business Aviation Taxes Seminar",
    href = "/events/2026-nbaa-business-aviation-taxes-seminar/",
    date = "April 28, 2026",
    location = "Denver, CO",
    excerpt = "Master complex aviation tax law at the seminar.",
  } = opts;
  return `
    <div class='menu-event-single col'>
      <a class="image-wrapper" href="${href}"><img alt="" /></a>
      <h5 class='menu-event-title'><a href="${href}">${title}</a></h5>
      <div class="event-date">${date}</div>
      <div class="location">${location}</div>
      <div class='menu-event-excerpt'><p>${excerpt}</p></div>
    </div>
  `;
};

const wrap = (...cards: string[]) =>
  `<html><body><div class="menu-event-reel">${cards.join("\n")}</div></body></html>`;

describe("parseNbaaDateRange", () => {
  it("parses single-day month-name format", () => {
    expect(parseNbaaDateRange("April 28, 2026")).toEqual({
      startDate: "2026-04-28T00:00:00.000Z",
      endDate: "2026-04-28T00:00:00.000Z",
    });
  });

  it("parses same-month range", () => {
    expect(parseNbaaDateRange("May 5-7, 2026")).toEqual({
      startDate: "2026-05-05T00:00:00.000Z",
      endDate: "2026-05-07T00:00:00.000Z",
    });
  });

  it("accepts abbreviated month with trailing period", () => {
    expect(parseNbaaDateRange("Oct. 18-19, 2026")?.startDate).toBe(
      "2026-10-18T00:00:00.000Z",
    );
    expect(parseNbaaDateRange("Sept. 28, 2026")?.endDate).toBe(
      "2026-09-28T00:00:00.000Z",
    );
  });

  it("parses cross-month range", () => {
    expect(parseNbaaDateRange("Sept. 28 - Oct. 1, 2026")).toEqual({
      startDate: "2026-09-28T00:00:00.000Z",
      endDate: "2026-10-01T00:00:00.000Z",
    });
  });

  it("accepts en-dash and em-dash", () => {
    expect(parseNbaaDateRange("May 5–7, 2026")?.endDate).toBe(
      "2026-05-07T00:00:00.000Z",
    );
    expect(parseNbaaDateRange("May 5—7, 2026")?.endDate).toBe(
      "2026-05-07T00:00:00.000Z",
    );
  });

  it("returns null for malformed input", () => {
    expect(parseNbaaDateRange("Spring 2026")).toBeNull();
    expect(parseNbaaDateRange("April 28")).toBeNull();
    expect(parseNbaaDateRange("28 April 2026")).toBeNull();
    expect(parseNbaaDateRange("")).toBeNull();
  });

  it("rejects out-of-range months and days", () => {
    expect(parseNbaaDateRange("Smarch 22, 2026")).toBeNull();
    expect(parseNbaaDateRange("April 99, 2026")).toBeNull();
  });
});

describe("parseNbaaPage", () => {
  it("returns [] on a page with no event cards", () => {
    expect(parseNbaaPage("<html></html>", PAGE_URL, SOURCE)).toEqual([]);
  });

  it("parses a single card with all fields", () => {
    const events = parseNbaaPage(wrap(card()), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe("NBAA Business Aviation Taxes Seminar");
    expect(e.startDate).toBe("2026-04-28T00:00:00.000Z");
    expect(e.endDate).toBe("2026-04-28T00:00:00.000Z");
    expect(e.country).toBe("US");
    expect(e.city).toBe("Denver");
    expect(e.organizerName).toBe("NBAA");
    expect(e.timezone).toBe("UTC");
    expect(e.sourceLocale).toBe("en");
    expect(e.sourceUrl).toBe(
      "https://nbaa.org/events/2026-nbaa-business-aviation-taxes-seminar/",
    );
  });

  it("handles absolute hrefs without re-prefixing the host", () => {
    const events = parseNbaaPage(
      wrap(card({ href: "https://nbaa.org/events/some/" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].sourceUrl).toBe("https://nbaa.org/events/some/");
  });

  it("classifies trade-fair / seminar / general", () => {
    const events = parseNbaaPage(
      wrap(
        card({ title: "NBAA Business Aviation Convention & Exhibition (NBAA-BACE)", href: "/a/" }),
        card({ title: "NBAA Maintenance Conference", href: "/b/" }),
        card({ title: "NBAA Tax, Regulatory & Risk Management Conference", href: "/c/" }),
        card({ title: "NBAA PDP Course: SMS for Business Aviation", href: "/d/" }),
        card({ title: "NBAA Awards Gala", href: "/e/" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events.map((e) => e.categoryCode)).toEqual([
      "trade-fair",
      "seminar",
      "seminar",
      "seminar",
      "general",
    ]);
  });

  it("keeps cross-month BACE-shaped events", () => {
    const events = parseNbaaPage(
      wrap(card({ date: "Sept. 28 - Oct. 1, 2026", href: "/a/" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].startDate).toBe("2026-09-28T00:00:00.000Z");
    expect(events[0].endDate).toBe("2026-10-01T00:00:00.000Z");
  });

  it("skips cards with malformed dates", () => {
    const events = parseNbaaPage(
      wrap(
        card({ date: "TBD", href: "/events/a/" }),
        card({ date: "Spring 2026", href: "/events/b/" }),
        card({ href: "/events/c/" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events).toHaveLength(1);
    expect(events[0].sourceUrl).toBe("https://nbaa.org/events/c/");
  });

  it("skips cards with no title", () => {
    const noTitle = `
      <div class='menu-event-single col'>
        <a class="image-wrapper" href="/x/"><img alt="" /></a>
        <h5 class='menu-event-title'><a href="/x/"></a></h5>
        <div class="event-date">April 28, 2026</div>
      </div>`;
    const events = parseNbaaPage(wrap(noTitle, card()), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("NBAA Business Aviation Taxes Seminar");
  });

  it("treats Online/Virtual locations as null city", () => {
    const events = parseNbaaPage(
      wrap(card({ location: "Online", href: "/o/" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].city).toBeNull();
    expect(events[0].country).toBe("US");
  });

  it("synthesises sourceUrl when href is empty", () => {
    const noHref = `
      <div class='menu-event-single col'>
        <h5 class='menu-event-title'><a href="">Lone Card</a></h5>
        <div class="event-date">April 28, 2026</div>
        <div class="location">Denver, CO</div>
      </div>`;
    const events = parseNbaaPage(wrap(noHref), PAGE_URL, SOURCE);
    expect(events[0].sourceUrl).toMatch(
      /^https:\/\/nbaa\.org\/events\/#[a-f0-9]{16}$/,
    );
  });

  it("description from menu-event-excerpt is preserved", () => {
    const events = parseNbaaPage(
      wrap(card({ excerpt: "Specific marketing copy that we want to keep." })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].description).toBe(
      "Specific marketing copy that we want to keep.",
    );
  });
});
