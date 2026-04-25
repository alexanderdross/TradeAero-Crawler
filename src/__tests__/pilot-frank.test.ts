import { describe, it, expect } from "vitest";
import { parsePilotFrankFeed } from "../parsers/pilot-frank.js";

const PAGE_URL = "https://pilot-frank.de/events/feed/";
const SOURCE = "pilot-frank.de";

const wrap = (...items: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:mec="http://webnus.net/rss/mec/">
<channel>
  <title>Pilot Frank Events</title>
  <link>https://pilot-frank.de/events/</link>
  ${items.join("\n")}
</channel>
</rss>`;

const item = (overrides: Record<string, string> = {}) => `
<item>
  <title>${overrides.title ?? "AERO #2026"}</title>
  <link>${overrides.link ?? "https://pilot-frank.de/events/aero-2026/"}</link>
  <dc:creator><![CDATA[${overrides.creator ?? "Frank Sterrmann"}]]></dc:creator>
  <description><![CDATA[${overrides.description ?? "<img src=\"x.jpg\"/> Die AERO 2026 startet."}]]></description>
  <mec:startDate>${overrides.startDate ?? "2026-04-22"}</mec:startDate>
  <mec:endDate>${overrides.endDate ?? "2026-04-25"}</mec:endDate>
  <mec:location>${overrides.location ?? ""}</mec:location>
</item>`;

describe("parsePilotFrankFeed", () => {
  it("returns [] on a feed with no items", () => {
    expect(parsePilotFrankFeed(wrap(), PAGE_URL, SOURCE)).toEqual([]);
  });

  it("returns [] on non-XML payload", () => {
    expect(parsePilotFrankFeed("<html>error</html>", PAGE_URL, SOURCE)).toEqual([]);
  });

  it("parses a typical AERO item", () => {
    const out = parsePilotFrankFeed(wrap(item()), PAGE_URL, SOURCE);
    expect(out).toHaveLength(1);
    const e = out[0];
    expect(e.title).toBe("AERO #2026");
    expect(e.startDate).toBe("2026-04-22T00:00:00.000Z");
    expect(e.endDate).toBe("2026-04-25T00:00:00.000Z");
    expect(e.country).toBe("DE");
    expect(e.organizerName).toBe("Frank Sterrmann");
    expect(e.eventUrl).toBe("https://pilot-frank.de/events/aero-2026/");
    expect(e.sourceUrl).toBe("https://pilot-frank.de/events/aero-2026/");
    expect(e.categoryCode).toBe("trade-fair"); // matches "aero"
  });

  it("uses mec:location ICAO when present", () => {
    const out = parsePilotFrankFeed(
      wrap(item({ location: "Flugplatz Breitscheid (EDGB)" })),
      PAGE_URL,
      SOURCE,
    );
    expect(out[0].icaoCode).toBe("EDGB");
    expect(out[0].venueName).toBe("Flugplatz Breitscheid");
  });

  it("falls back to title-side ICAO when mec:location is empty", () => {
    const out = parsePilotFrankFeed(
      wrap(item({ title: "Saison Start in Offenburg (EDTO)", location: "" })),
      PAGE_URL,
      SOURCE,
    );
    expect(out[0].icaoCode).toBe("EDTO");
  });

  it("strips HTML img + 'The post … appeared first on …' from description", () => {
    const desc =
      '<img src="x.jpg"/>Schöner Tag.<p>The post AERO appeared first on Pilot Frank.</p>';
    const out = parsePilotFrankFeed(
      wrap(item({ description: desc })),
      PAGE_URL,
      SOURCE,
    );
    expect(out[0].description).toBe("Schöner Tag.");
  });

  it("uses startDate as endDate when endDate is missing", () => {
    // fast-DOM: empty mec:endDate becomes "" which the parser treats as
    // missing.
    const out = parsePilotFrankFeed(
      wrap(item({ endDate: "" })),
      PAGE_URL,
      SOURCE,
    );
    expect(out[0].endDate).toBe(out[0].startDate);
  });

  it("classifies fly-ins / hangar / seminars", () => {
    const out = parsePilotFrankFeed(
      wrap(
        item({ title: "Currywurst Fly-In 1/2026" }),
        item({ title: "ROCK im HANGAR in Hundheim" }),
        item({ title: "UL-Schulung Tagesseminar" }),
      ),
      PAGE_URL,
      SOURCE,
    );
    expect(out.map((e) => e.categoryCode)).toEqual([
      "meetup",
      "meetup",
      "seminar",
    ]);
  });

  it("emits stable sourceUrl on identical input", () => {
    const a = parsePilotFrankFeed(wrap(item()), PAGE_URL, SOURCE);
    const b = parsePilotFrankFeed(wrap(item()), PAGE_URL, SOURCE);
    expect(a[0].sourceUrl).toEqual(b[0].sourceUrl);
  });
});
