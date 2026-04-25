import { describe, it, expect } from "vitest";
import {
  parseAeroFriedrichshafenPage,
  parseAeroDateRange,
  extractAeroDateString,
} from "../parsers/aero-friedrichshafen.js";

const PAGE_URL = "https://www.aero-expo.com/";
const SOURCE = "aero-expo.com";

const buildHtml = (opts: {
  lang?: string;
  title?: string;
  dateBlock?: string;
  description?: string;
} = {}) => `
<html lang="${opts.lang ?? "en"}">
  <head>
    <title>${opts.title ?? "April 22 - 25, 2026 | AERO Friedrichshafen"}</title>
    <meta name="description" content="${opts.description ?? "AERO Friedrichshafen – the global trade show for general aviation."}" />
    <meta property="og:description" content="${opts.description ?? "AERO Friedrichshafen – the global trade show for general aviation."}" />
  </head>
  <body>
    <div class="logo__slogan">
      <div class="meta">The Leading Show<br/>for General Aviation</div>
      <div class="date">${opts.dateBlock ?? "April 22 - 25, 2026"}</div>
    </div>
    <h1>Welcome to AERO Friedrichshafen 2026!</h1>
  </body>
</html>`;

describe("parseAeroDateRange", () => {
  it("parses English same-month range", () => {
    expect(parseAeroDateRange("April 22 - 25, 2026")).toEqual({
      startDate: "2026-04-22T00:00:00.000Z",
      endDate: "2026-04-25T00:00:00.000Z",
    });
  });

  it("accepts en-dash and em-dash range separators", () => {
    expect(parseAeroDateRange("April 22 – 25, 2026")?.startDate).toBe(
      "2026-04-22T00:00:00.000Z",
    );
    expect(parseAeroDateRange("April 22 — 25, 2026")?.endDate).toBe(
      "2026-04-25T00:00:00.000Z",
    );
  });

  it("parses cross-month English range", () => {
    expect(parseAeroDateRange("April 28 - May 1, 2026")).toEqual({
      startDate: "2026-04-28T00:00:00.000Z",
      endDate: "2026-05-01T00:00:00.000Z",
    });
  });

  it("parses English single day", () => {
    expect(parseAeroDateRange("April 22, 2026")).toEqual({
      startDate: "2026-04-22T00:00:00.000Z",
      endDate: "2026-04-22T00:00:00.000Z",
    });
  });

  it("parses German same-month range", () => {
    expect(parseAeroDateRange("22. - 25. April 2026")).toEqual({
      startDate: "2026-04-22T00:00:00.000Z",
      endDate: "2026-04-25T00:00:00.000Z",
    });
  });

  it("parses German single day", () => {
    expect(parseAeroDateRange("22. April 2026")).toEqual({
      startDate: "2026-04-22T00:00:00.000Z",
      endDate: "2026-04-22T00:00:00.000Z",
    });
  });

  it("returns null for malformed input", () => {
    expect(parseAeroDateRange("Spring 2026")).toBeNull();
    expect(parseAeroDateRange("22 April 26")).toBeNull();
    expect(parseAeroDateRange("")).toBeNull();
  });

  it("rejects out-of-range months and days", () => {
    expect(parseAeroDateRange("Smarch 22, 2026")).toBeNull();
    expect(parseAeroDateRange("April 99, 2026")).toBeNull();
  });
});

describe("extractAeroDateString", () => {
  it("prefers <title> when present", () => {
    expect(
      extractAeroDateString(buildHtml({ title: "April 22 - 25, 2026 | AERO Friedrichshafen" })),
    ).toBe("April 22 - 25, 2026");
  });

  it("falls back to .date block when <title> doesn't carry the date", () => {
    expect(
      extractAeroDateString(
        buildHtml({
          title: "AERO Friedrichshafen | The Leading Show",
          dateBlock: "April 22 - 25, 2026",
        }),
      ),
    ).toBe("April 22 - 25, 2026");
  });

  it("returns null when no recognisable date string is on the page", () => {
    expect(
      extractAeroDateString(
        buildHtml({
          title: "AERO Friedrichshafen",
          dateBlock: "Coming Spring 2026",
        }),
      ),
    ).toBeNull();
  });

  it("collapses multi-line whitespace inside the .date block", () => {
    const html = buildHtml({
      title: "AERO Friedrichshafen",
      dateBlock: `
        April 22 -

         25, 2026
      `,
    });
    expect(extractAeroDateString(html)).toBe("April 22 - 25, 2026");
  });
});

describe("parseAeroFriedrichshafenPage", () => {
  it("emits one ParsedEvent for the trade fair", () => {
    const events = parseAeroFriedrichshafenPage(buildHtml(), PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe("AERO Friedrichshafen 2026");
    expect(e.startDate).toBe("2026-04-22T00:00:00.000Z");
    expect(e.endDate).toBe("2026-04-25T00:00:00.000Z");
    expect(e.country).toBe("DE");
    expect(e.city).toBe("Friedrichshafen");
    expect(e.icaoCode).toBe("EDNY");
    expect(e.timezone).toBe("Europe/Berlin");
    expect(e.categoryCode).toBe("trade-fair");
    expect(e.organizerName).toBe("Messe Friedrichshafen GmbH");
    expect(e.latitude).toBeCloseTo(47.67, 1);
    expect(e.longitude).toBeCloseTo(9.51, 1);
  });

  it("yields a stable per-year sourceUrl that anchors cross-day dedup", () => {
    const events = parseAeroFriedrichshafenPage(buildHtml(), PAGE_URL, SOURCE);
    expect(events[0].sourceUrl).toBe("https://www.aero-expo.com/#2026");
  });

  it("detects German locale from <html lang>", () => {
    const events = parseAeroFriedrichshafenPage(
      buildHtml({
        lang: "de",
        title: "22. - 25. April 2026 | AERO Friedrichshafen",
        dateBlock: "22. - 25. April 2026",
      }),
      "https://www.aero-expo.de/",
      "aero-expo.de",
    );
    expect(events[0].sourceLocale).toBe("de");
    expect(events[0].subtitle).toBe("Die Leitmesse für die Allgemeine Luftfahrt");
  });

  it("returns [] when the page has no parseable date", () => {
    expect(
      parseAeroFriedrichshafenPage(
        buildHtml({
          title: "AERO Friedrichshafen",
          dateBlock: "TBC",
        }),
        PAGE_URL,
        SOURCE,
      ),
    ).toEqual([]);
  });

  it("uses og:description when present, else the description meta", () => {
    const html = `
      <html lang="en">
        <head>
          <title>April 22 - 25, 2026 | AERO Friedrichshafen</title>
          <meta name="description" content="Plain description." />
          <meta property="og:description" content="Open Graph description." />
        </head>
        <body><div class="date">April 22 - 25, 2026</div></body>
      </html>`;
    expect(parseAeroFriedrichshafenPage(html, PAGE_URL, SOURCE)[0].description)
      .toBe("Open Graph description.");
  });
});
