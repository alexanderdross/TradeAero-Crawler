import { describe, it, expect } from "vitest";
import {
  parseFliegermagazinPage,
  parseFliegermagazinDateRange,
  parseFliegermagazinTotalPages,
  extractBigmapCoords,
} from "../parsers/fliegermagazin.js";

const PAGE_URL = "https://www.fliegermagazin.de/termine/";
const SOURCE = "fliegermagazin.de";

describe("parseFliegermagazinDateRange", () => {
  it("parses a single date", () => {
    expect(parseFliegermagazinDateRange("09.05.2026")).toEqual({
      startDate: "2026-05-09T00:00:00.000Z",
      endDate: "2026-05-09T00:00:00.000Z",
    });
  });

  it("parses a hyphen-separated range", () => {
    expect(parseFliegermagazinDateRange("10.04.2026 - 25.09.2026")).toEqual({
      startDate: "2026-04-10T00:00:00.000Z",
      endDate: "2026-09-25T00:00:00.000Z",
    });
  });

  it("returns null on prose / unparseable input", () => {
    expect(parseFliegermagazinDateRange("Mai 2026")).toBeNull();
    expect(parseFliegermagazinDateRange("")).toBeNull();
  });
});

describe("parseFliegermagazinTotalPages", () => {
  it("returns 1 when the indicator is missing", () => {
    expect(parseFliegermagazinTotalPages("<html>nothing</html>")).toBe(1);
  });

  it("returns the parsed page count", () => {
    expect(parseFliegermagazinTotalPages("<p>Seite 1 von 4</p>")).toBe(4);
  });

  it("caps absurd values at 20 to bound the crawl", () => {
    expect(parseFliegermagazinTotalPages("<p>Seite 1 von 999</p>")).toBe(20);
  });
});

describe("extractBigmapCoords", () => {
  it("returns an empty Map when the blob is missing", () => {
    expect(extractBigmapCoords("<html></html>").size).toBe(0);
  });

  it("parses lat/long keyed by event URL", () => {
    const html = `<section class="bigmap"><div data-data='{"33312":{"lat":"53.0","long":"8.5","from":"10.04.2026","until":"25.09.2026","title":"AAG","url":"https://www.fliegermagazin.de/termine/aag/","image":""}}'></div></section>`;
    const map = extractBigmapCoords(html);
    expect(map.size).toBe(1);
    expect(map.get("https://www.fliegermagazin.de/termine/aag/")).toEqual({
      lat: 53.0,
      lon: 8.5,
    });
  });

  it("ignores entries with non-numeric coordinates", () => {
    const html = `<div data-data='{"x":{"lat":"abc","long":"8.5","url":"https://x.test/"}}'></div>`;
    expect(extractBigmapCoords(html).size).toBe(0);
  });
});

describe("parseFliegermagazinPage", () => {
  it("returns [] when there are no /termine/ articles", () => {
    expect(parseFliegermagazinPage("<html></html>", PAGE_URL, SOURCE)).toEqual(
      [],
    );
  });

  it("parses a typical card", () => {
    const html = `
      <article>
        <div class="article-item-image"><a class="image-wrap" href="https://www.fliegermagazin.de/termine/brazzeltag/"></a></div>
        <div class="article-item-content">
          <div class="article-headline" data-headline="red">Flugtage</div>
          <time class="article-time" datetime="2026-02-28">09.05.2026 - 10.05.2026</time>
          <h3><a href="https://www.fliegermagazin.de/termine/brazzeltag/">BRAZZELTAG</a></h3>
        </div>
      </article>`;
    const events = parseFliegermagazinPage(html, PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe("BRAZZELTAG");
    expect(e.startDate).toBe("2026-05-09T00:00:00.000Z");
    expect(e.endDate).toBe("2026-05-10T00:00:00.000Z");
    expect(e.categoryCode).toBe("airfield-festival"); // matches "flugtag"
    expect(e.subtitle).toBe("Flugtage");
    expect(e.sourceUrl).toBe("https://www.fliegermagazin.de/termine/brazzeltag/");
    expect(e.country).toBe("DE");
  });

  it("attaches lat/long from the bigmap blob when the URL matches", () => {
    const html = `
      <section class="bigmap">
        <div data-data='{"1":{"lat":"49.30","long":"8.45","from":"09.05.2026","until":"10.05.2026","title":"BRAZZELTAG","url":"https://www.fliegermagazin.de/termine/brazzeltag/","image":""}}'></div>
      </section>
      <article>
        <div class="article-item-image"><a class="image-wrap" href="https://www.fliegermagazin.de/termine/brazzeltag/"></a></div>
        <div class="article-item-content">
          <div class="article-headline" data-headline="red">Flugtage</div>
          <time class="article-time">09.05.2026 - 10.05.2026</time>
          <h3><a href="https://www.fliegermagazin.de/termine/brazzeltag/">BRAZZELTAG</a></h3>
        </div>
      </article>`;
    const events = parseFliegermagazinPage(html, PAGE_URL, SOURCE);
    expect(events[0].latitude).toBe(49.3);
    expect(events[0].longitude).toBe(8.45);
  });

  it("classifies trade-fair / messe / airshow / seminar correctly", () => {
    const card = (h: string, t: string) => `
      <article>
        <div class="article-item-content">
          <div class="article-headline">${h}</div>
          <time class="article-time">09.05.2026</time>
          <h3><a href="https://www.fliegermagazin.de/termine/x/">${t}</a></h3>
        </div>
      </article>`;
    const events = parseFliegermagazinPage(
      card("Messen", "AERO Friedrichshafen") +
        card("Airshow", "Pardubice Airshow") +
        card("Seminare", "Pilotenfortbildung"),
      PAGE_URL,
      SOURCE,
    );
    expect(events.map((e) => e.categoryCode)).toEqual([
      "trade-fair",
      "airshow",
      "seminar",
    ]);
  });

  it("ignores articles that are not /termine/ links (sidebar news / promos)", () => {
    const html = `
      <article>
        <div class="article-item-content">
          <h3><a href="https://www.fliegermagazin.de/news/random-article/">Sidebar news</a></h3>
          <time class="article-time">09.05.2026</time>
        </div>
      </article>`;
    expect(parseFliegermagazinPage(html, PAGE_URL, SOURCE)).toEqual([]);
  });
});
