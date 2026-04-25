import { describe, it, expect } from "vitest";
import {
  parseDulvPage,
  parseDulvLastPageIndex,
  extractDulvDetailTitle,
} from "../parsers/dulv.js";

const PAGE_URL = "https://www.dulv.de/veranstaltungen";
const SOURCE = "dulv.de";

const eventBlock = (opts: {
  nodeId?: string;
  alt?: string;
  startdatum?: string;
  enddatum?: string;
  ort?: string;
  beschreibung?: string;
} = {}) => {
  const {
    nodeId = "527",
    alt = "UL-Fly-In Jesenwang",
    startdatum = "01.05.2026",
    enddatum = "01.05.2026",
    ort = "Jesenwang EDMJ",
    beschreibung = "<p>UL-Fly-in Flugplatz Jesenwang am 1. Mai 2026 — Beginn ab 9:30 Uhr.</p>",
  } = opts;
  return `
    <div data-history-node-id="${nodeId}" class="layout layout--twocol">
      <div class="layout__region layout__region--first">
        <div class="field field--name-field-bild">
          <div class="field__items">
            <div class="field__item"><img alt="${alt}" title="${alt}" /></div>
          </div>
        </div>
      </div>
      <div class="layout__region layout__region--second">
        <div class="field field--name-field-startdatum"><div class="field__label">Startdatum</div>
          <div class="field__item">${startdatum}</div></div>
        <div class="field field--name-field-enddatum"><div class="field__label">Enddatum</div>
          <div class="field__item">${enddatum}</div></div>
        <div class="field field--name-field-ort"><div class="field__label">Ort</div>
          <div class="field__item">${ort}</div></div>
        <div class="field field--name-field-beschreibung"><div class="field__label">Beschreibung</div>
          <div class="field__item">${beschreibung}</div></div>
      </div>
    </div>
  `;
};

const wrap = (...blocks: string[]) => `<html><body>${blocks.join("\n")}</body></html>`;

describe("parseDulvPage", () => {
  it("returns [] on a page with no event blocks", () => {
    expect(parseDulvPage("<html></html>", PAGE_URL, SOURCE)).toEqual([]);
  });

  it("parses a single event block", () => {
    const events = parseDulvPage(wrap(eventBlock()), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe("UL-Fly-In Jesenwang");
    expect(e.startDate).toBe("2026-05-01T00:00:00.000Z");
    expect(e.endDate).toBe("2026-05-01T00:00:00.000Z");
    expect(e.icaoCode).toBe("EDMJ");
    expect(e.venueName).toBe("Jesenwang");
    expect(e.country).toBe("DE");
    expect(e.organizerName).toBe("DULV");
    expect(e.timezone).toBe("Europe/Berlin");
    expect(e.sourceLocale).toBe("de");
    // detailUrl uses the data-history-node-id so the partial UNIQUE
    // index dedups the same event across crawls.
    expect(e.sourceUrl).toBe("https://www.dulv.de/node/527");
    expect(e.eventUrl).toBe("https://www.dulv.de/node/527");
  });

  it("parses multi-day event ranges from start/end fields", () => {
    const events = parseDulvPage(
      wrap(
        eventBlock({
          nodeId: "526",
          alt: "DULV Fluglehrer-Lehrgang",
          startdatum: "25.05.2026",
          enddatum: "31.05.2026",
          ort: "Eisenach-Kindel",
        }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].startDate).toBe("2026-05-25T00:00:00.000Z");
    expect(events[0].endDate).toBe("2026-05-31T00:00:00.000Z");
    expect(events[0].dateRangeText).toBe("25.05.2026 - 31.05.2026");
    expect(events[0].categoryCode).toBe("seminar"); // "Lehrgang" keyword
  });

  it("classifies category by title keyword", () => {
    const events = parseDulvPage(
      wrap(
        eventBlock({ alt: "Tannkosh Flugtage 2026", nodeId: "1" }),
        eventBlock({ alt: "DM Streckenflug 2026", nodeId: "2" }),
        eventBlock({ alt: "UL-Infotage Schmallenberg", nodeId: "3" }),
        eventBlock({ alt: "AERO Messe Friedrichshafen", nodeId: "4" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events.map((e) => e.categoryCode)).toEqual([
      "airshow",
      "competition",
      "seminar",
      "trade-fair",
    ]);
  });

  it("falls back to description's first heading when image alt is a single-word filename", () => {
    const events = parseDulvPage(
      wrap(
        eventBlock({
          alt: "Waffelflyin",
          beschreibung: "<h4>Fliegertreffen mit Familiencharme</h4><p>Das 5. Waffel Fly-In…</p>",
        }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].title).toBe("Fliegertreffen mit Familiencharme");
  });

  it("falls back to first sentence of description when alt is a filename and no heading exists", () => {
    const events = parseDulvPage(
      wrap(
        eventBlock({
          alt: "Waffelflyin",
          beschreibung: "<p>Das 5. Waffel Fly-In findet am Sonntag.</p><p>Mehr Infos auf der Webseite.</p>",
        }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].title).toBe("Das 5. Waffel Fly-In findet am Sonntag.");
  });

  it("extracts ICAO code from venue text in parens", () => {
    const events = parseDulvPage(
      wrap(eventBlock({ ort: "Schmallenberg-Rennefeld (EDKR)" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].icaoCode).toBe("EDKR");
    expect(events[0].venueName).toBe("Schmallenberg-Rennefeld");
  });

  it("drops rows with missing start date silently", () => {
    const noDate = eventBlock({ startdatum: "", enddatum: "" });
    const events = parseDulvPage(wrap(noDate, eventBlock({ nodeId: "999" })), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    expect(events[0].sourceUrl).toBe("https://www.dulv.de/node/999");
  });

  it("drops rows with malformed German date strings", () => {
    const events = parseDulvPage(
      wrap(eventBlock({ startdatum: "1st of May 2026" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events).toEqual([]);
  });

  it("uses null end date row by mirroring start when only end is empty", () => {
    const events = parseDulvPage(
      wrap(eventBlock({ enddatum: "" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].startDate).toBe(events[0].endDate);
  });

  it("preserves multiple separate event blocks", () => {
    const events = parseDulvPage(
      wrap(eventBlock({ nodeId: "1" }), eventBlock({ nodeId: "2" }), eventBlock({ nodeId: "3" })),
      PAGE_URL,
      SOURCE,
    );
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.sourceUrl)).toEqual([
      "https://www.dulv.de/node/1",
      "https://www.dulv.de/node/2",
      "https://www.dulv.de/node/3",
    ]);
  });

  it("description is trimmed to 1200 chars to keep payload bounded", () => {
    const big = "<p>" + "x".repeat(2000) + "</p>";
    const events = parseDulvPage(
      wrap(eventBlock({ beschreibung: big })),
      PAGE_URL,
      SOURCE,
    );
    expect(events[0].description?.length).toBeLessThanOrEqual(1200);
  });
});

describe("parseDulvLastPageIndex", () => {
  it("returns 0 when no pager is present", () => {
    expect(parseDulvLastPageIndex("<html></html>")).toBe(0);
  });

  it("returns the largest visible 0-based page index", () => {
    const html = `
      <ul class="pagination">
        <li><a href="/Veranstaltungen?page=1">2</a></li>
        <li><a href="/Veranstaltungen?page=2">3</a></li>
        <li><a href="/Veranstaltungen?page=4" rel="last">5</a></li>
      </ul>`;
    expect(parseDulvLastPageIndex(html)).toBe(4);
  });

  it("clamps to 9 (maximum 10 pages)", () => {
    const html = `<a href="/Veranstaltungen?page=42">43</a>`;
    expect(parseDulvLastPageIndex(html)).toBe(9);
  });

  it("ignores hash anchors and other query parameters", () => {
    const html = `
      <a href="/Veranstaltungen?other=1">first</a>
      <a href="/Veranstaltungen?page=2&foo=bar">3</a>`;
    expect(parseDulvLastPageIndex(html)).toBe(2);
  });
});

describe("extractDulvDetailTitle", () => {
  it("reads the title from the field--name-title span inside h1.page-title", () => {
    const html = `
      <h1 class="page-title">
        <span class="field field--name-title field--type-string field--label-hidden">5. Waffel Fly-In auf dem Rennefeld </span>
      </h1>`;
    expect(extractDulvDetailTitle(html)).toBe("5. Waffel Fly-In auf dem Rennefeld");
  });

  it("falls back to h1.page-title text when the inner span is absent", () => {
    const html = `<h1 class="page-title">UL-Fly-In Jesenwang</h1>`;
    expect(extractDulvDetailTitle(html)).toBe("UL-Fly-In Jesenwang");
  });

  it("returns null when the page has no h1.page-title (404 / layout change)", () => {
    expect(extractDulvDetailTitle("<html><body><h1>Other</h1></body></html>"))
      .toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractDulvDetailTitle("")).toBeNull();
  });

  it("collapses whitespace inside the title", () => {
    const html = `<h1 class="page-title"><span class="field--name-title">  UL-Fly-In   Jesenwang  </span></h1>`;
    expect(extractDulvDetailTitle(html)).toBe("UL-Fly-In Jesenwang");
  });
});
