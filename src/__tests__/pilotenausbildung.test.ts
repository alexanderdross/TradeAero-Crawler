import { describe, it, expect } from "vitest";
import {
  parsePilotenausbildungPage,
  parseLooseGermanDateRange,
} from "../parsers/pilotenausbildung.js";

const PAGE_URL = "https://pilotenausbildung.net/ausflugstipps/";
const SOURCE = "pilotenausbildung.net";

// ---------------------------------------------------------------------------
// parseLooseGermanDateRange — operator types dates inconsistently across
// rows; the parser has to absorb everything they actually use.
// ---------------------------------------------------------------------------
describe("parseLooseGermanDateRange", () => {
  it("parses single-day dotted dates", () => {
    const r = parseLooseGermanDateRange("09.05.2026");
    expect(r).toEqual({
      startDate: "2026-05-09T00:00:00.000Z",
      endDate: "2026-05-09T00:00:00.000Z",
    });
  });

  it("parses range with shared month/year (en-dash)", () => {
    const r = parseLooseGermanDateRange("20. – 26.07.2026");
    expect(r).toEqual({
      startDate: "2026-07-20T00:00:00.000Z",
      endDate: "2026-07-26T00:00:00.000Z",
    });
  });

  it("parses range with shared month/year (no spaces around hyphen)", () => {
    const r = parseLooseGermanDateRange("20.-24.07.2026");
    expect(r).toEqual({
      startDate: "2026-07-20T00:00:00.000Z",
      endDate: "2026-07-24T00:00:00.000Z",
    });
  });

  it("parses range with extra whitespace", () => {
    const r = parseLooseGermanDateRange("30. – 31.05.2026");
    expect(r).toEqual({
      startDate: "2026-05-30T00:00:00.000Z",
      endDate: "2026-05-31T00:00:00.000Z",
    });
  });

  it("parses cross-month range with full date on both sides", () => {
    const r = parseLooseGermanDateRange("10.04.2026 - 25.09.2026");
    expect(r).toEqual({
      startDate: "2026-04-10T00:00:00.000Z",
      endDate: "2026-09-25T00:00:00.000Z",
    });
  });

  it("returns null on prose / unparseable input", () => {
    expect(parseLooseGermanDateRange("nächsten Sommer")).toBeNull();
    expect(parseLooseGermanDateRange("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parsePilotenausbildungPage — full DOM walk. Fixtures mirror the real
// page's <h2>+<p> layout per section (sample captured 2026-04-25).
// ---------------------------------------------------------------------------
describe("parsePilotenausbildungPage", () => {
  it("returns [] on an empty page", () => {
    expect(parsePilotenausbildungPage("<html></html>", PAGE_URL, SOURCE)).toEqual([]);
  });

  it("parses Messen + Airshow + Fly-In sections", () => {
    const html = `
      <h2>Luftfahrt Museen:</h2>
      <table><tr><td>Some museum row — must be skipped</td></tr></table>
      <h2>Luftfahrt Messen in Europa 2026</h2>
      <p><a href="https://www.aero-expo.de/">22. – 25.04.2026 – Aero Expo Friedrichshafen – 88046 Friedrichshafen</a></p>
      <h2>Airshows/Flugshows in Europa 2026</h2>
      <p><a href="https://example.test/airshow">30. – 31.05.2026 – Pardubice Airshow, Tschechien</a></p>
      <h2>2026: Fly-Inn's, Pilotentreffen und Events</h2>
      <p><a href="https://example.test/fly">09.05.2026 – Blaulichttreffen am Flugplatz Bienenfarm (EDOI)</a></p>
      <h2>Aktivitäten an Flughäfen:</h2>
      <table><tr><td>Activities — must be skipped</td></tr></table>
    `;
    const events = parsePilotenausbildungPage(html, PAGE_URL, SOURCE);
    expect(events).toHaveLength(3);

    const fair = events.find((e) => e.title.includes("Aero Expo"));
    expect(fair?.categoryCode).toBe("trade-fair");
    expect(fair?.startDate).toBe("2026-04-22T00:00:00.000Z");
    expect(fair?.endDate).toBe("2026-04-25T00:00:00.000Z");
    expect(fair?.country).toBe("DE");
    expect(fair?.eventUrl).toBe("https://www.aero-expo.de/");

    const airshow = events.find((e) => e.title.includes("Pardubice"));
    expect(airshow?.categoryCode).toBe("airshow");
    expect(airshow?.country).toBe("CZ");

    const flyin = events.find((e) => e.title.includes("Blaulichttreffen"));
    expect(flyin?.categoryCode).toBe("meetup");
    expect(flyin?.icaoCode).toBe("EDOI");
  });

  it("skips cancelled rows wrapped in <del>", () => {
    const html = `
      <h2>Luftfahrt Messen in Europa 2026</h2>
      <p><a href="https://example.test/cancelled"><del>20. – 21.02.2026 – Pilot Expo – Brüssel</del></a></p>
      <p><a href="https://example.test/live">22. – 25.04.2026 – Aero Expo – Friedrichshafen</a></p>
    `;
    const events = parsePilotenausbildungPage(html, PAGE_URL, SOURCE);
    expect(events).toHaveLength(1);
    expect(events[0].title).toContain("Aero Expo");
  });

  it("skips reference-only Museum / Aktivitäten sections entirely", () => {
    const html = `
      <h2>Luftfahrt Museen:</h2>
      <table><tr><td>01067 Dresden</td><td>Verkehrs Museum Dresden</td><td>EDAR</td></tr></table>
      <h2>Aktivitäten an Flughäfen:</h2>
      <p>05.05.2026 – Should not be picked up because section is reference-only</p>
    `;
    const events = parsePilotenausbildungPage(html, PAGE_URL, SOURCE);
    expect(events).toHaveLength(0);
  });

  it("infers country from trailing location segment (USA / UK / Belgien / Frankreich)", () => {
    const html = `
      <h2>Airshows/Flugshows in Europa 2026</h2>
      <p><a href="x">20. – 26.07.2026 – EAA AirVenture Oshkosh – USA</a></p>
      <p><a href="y">27. – 28.06.2026 – Battle of Britain Airshow – Headcorn Aerodrome, UK</a></p>
      <p><a href="z">02. – 04.06.2026 – EBACE 2026 – Belgien</a></p>
      <p><a href="w">04. – 06.06.2026 – France Air Expo – LYON BRON, Frankreich</a></p>
    `;
    const events = parsePilotenausbildungPage(html, PAGE_URL, SOURCE);
    expect(events).toHaveLength(4);
    expect(events.find((e) => e.title.includes("Oshkosh"))?.country).toBe("US");
    expect(events.find((e) => e.title.includes("Britain"))?.country).toBe("GB");
    expect(events.find((e) => e.title.includes("EBACE"))?.country).toBe("BE");
    expect(events.find((e) => e.title.includes("Air Expo"))?.country).toBe("FR");
  });

  it("emits stable sourceUrl on identical title+date+link", () => {
    const html = `
      <h2>Luftfahrt Messen in Europa 2026</h2>
      <p><a href="https://example.test/repeat">22. – 25.04.2026 – Repeat – Friedrichshafen</a></p>
    `;
    const a = parsePilotenausbildungPage(html, PAGE_URL, SOURCE);
    const b = parsePilotenausbildungPage(html, PAGE_URL, SOURCE);
    expect(a[0].sourceUrl).toEqual(b[0].sourceUrl);
  });
});
