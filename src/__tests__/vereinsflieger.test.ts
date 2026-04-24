import { describe, it, expect } from "vitest";
import {
  parseVereinsfliegerPage,
  parseGermanDateRange,
  extractIcaoFromVenue,
  extractCityFromVenue,
  categoryCodeForSourceId,
  synthesizeEventDescription,
} from "../parsers/vereinsflieger.js";

const PAGE_URL = "https://vereinsflieger.de/publiccalendar/?category=1";
const SOURCE = "vereinsflieger.de";

// ---------------------------------------------------------------------------
// categoryCodeForSourceId
// ---------------------------------------------------------------------------
describe("categoryCodeForSourceId", () => {
  it("maps 1..5 to the curated event_categories codes", () => {
    expect(categoryCodeForSourceId(1)).toBe("seminar");
    expect(categoryCodeForSourceId(2)).toBe("competition");
    expect(categoryCodeForSourceId(3)).toBe("flying-camp");
    expect(categoryCodeForSourceId(4)).toBe("airfield-festival");
    expect(categoryCodeForSourceId(5)).toBe("trade-fair");
  });

  it("maps 6 to the new 'general' code", () => {
    expect(categoryCodeForSourceId(6)).toBe("general");
  });

  it("falls back to 'general' for unknown ids", () => {
    expect(categoryCodeForSourceId(0)).toBe("general");
    expect(categoryCodeForSourceId(99)).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// parseGermanDateRange
// ---------------------------------------------------------------------------
describe("parseGermanDateRange", () => {
  it("parses a single-day date", () => {
    const result = parseGermanDateRange("24.04.2026");
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-04-24T00:00:00.000Z");
    expect(result!.endDate).toBe("2026-04-24T00:00:00.000Z");
  });

  it("parses a multi-day date range with hyphen", () => {
    const result = parseGermanDateRange("24.04.2026 - 26.04.2026");
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-04-24T00:00:00.000Z");
    expect(result!.endDate).toBe("2026-04-26T00:00:00.000Z");
  });

  it("parses a range with unicode en-dash", () => {
    const result = parseGermanDateRange("01.05.2026 – 03.05.2026");
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-05-01T00:00:00.000Z");
    expect(result!.endDate).toBe("2026-05-03T00:00:00.000Z");
  });

  it("returns null for unparseable input", () => {
    expect(parseGermanDateRange("not a date")).toBeNull();
    expect(parseGermanDateRange("")).toBeNull();
    expect(parseGermanDateRange("32.13.2026")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractIcaoFromVenue
// ---------------------------------------------------------------------------
describe("extractIcaoFromVenue", () => {
  it("strips trailing ICAO code", () => {
    const result = extractIcaoFromVenue("Flugplatz Strausberg (EDAZ)");
    expect(result.name).toBe("Flugplatz Strausberg");
    expect(result.icao).toBe("EDAZ");
  });

  it("extracts inline ICAO code", () => {
    const result = extractIcaoFromVenue("EDTF Schwenningen");
    expect(result.icao).toBe("EDTF");
    expect(result.name).toBe("Schwenningen");
  });

  it("returns null ICAO when absent", () => {
    const result = extractIcaoFromVenue("Podium Ost");
    expect(result.name).toBe("Podium Ost");
    expect(result.icao).toBeNull();
  });

  it("handles empty input", () => {
    const result = extractIcaoFromVenue("");
    expect(result.name).toBe("");
    expect(result.icao).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractCityFromVenue
// ---------------------------------------------------------------------------
describe("extractCityFromVenue", () => {
  it("extracts city from German postal code pattern", () => {
    expect(extractCityFromVenue("12345 Berlin Schönefeld")).toBe("Berlin Schönefeld");
  });

  it("extracts city from comma-separated pattern", () => {
    expect(extractCityFromVenue("Flugplatz Strausberg, Brandenburg")).toBe("Brandenburg");
  });

  it("returns null when no city pattern matches", () => {
    expect(extractCityFromVenue("Podium Ost")).toBeNull();
  });

  it("handles empty input", () => {
    expect(extractCityFromVenue("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseVereinsfliegerPage — main parser
// ---------------------------------------------------------------------------
describe("parseVereinsfliegerPage", () => {
  it("parses a single event row from a category=1 page", () => {
    const html = `
      <html><body>
        <table style="max-width:100%">
          <tbody>
            <tr>
              <td colspan="2" style="background-color:#eee">April 2026</td>
            </tr>
            <tr>
              <td>
                <div class="block"><span class="day">24.</span><span class="month">Apr</span></div>
              </td>
              <td>
                <div class="pubcal_title">Podiumsdiskussion -FIS - Deutschland-Österreich - Schweiz</div>
                <div class="pubcal_daterange icon-clock">24.04.2026</div>
                <div class="pubcal_daterange icon-info">Seminar - Fortbildung</div>
                <div class="pubcal_location">
                  <a class="icon-location" href="https://www.google.de/maps/dir/Podium Ost">Podium Ost</a>
                </div>
                <div class="pubcal_cidname icon-home redirectto" data="/publiccalendar/redirectto">
                  Luftsportverband Rheinland-Pfalz e.V.
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    const events = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    expect(events.length).toBe(1);

    const event = events[0];
    expect(event.title).toBe("Podiumsdiskussion -FIS - Deutschland-Österreich - Schweiz");
    expect(event.subtitle).toBe("Seminar - Fortbildung");
    expect(event.dateRangeText).toBe("24.04.2026");
    expect(event.startDate).toBe("2026-04-24T00:00:00.000Z");
    expect(event.endDate).toBe("2026-04-24T00:00:00.000Z");
    expect(event.timezone).toBe("Europe/Berlin");
    expect(event.country).toBe("DE");
    expect(event.venueName).toBe("Podium Ost");
    expect(event.icaoCode).toBeNull();
    expect(event.organizerName).toBe("Luftsportverband Rheinland-Pfalz e.V.");
    expect(event.categoryCode).toBe("seminar");
    expect(event.sourceCategoryId).toBe(1);
    expect(event.sourceName).toBe(SOURCE);
    expect(event.sourceUrl).toMatch(/^https:\/\/vereinsflieger\.de\/publiccalendar\/\?category=1#[a-f0-9]{16}$/);
  });

  it("parses a multi-day date range correctly", () => {
    const html = `
      <html><body>
        <table>
          <tbody>
            <tr>
              <td>
                <div class="pubcal_title">Fliegerlager Nord</div>
                <div class="pubcal_daterange icon-clock">01.08.2026 - 15.08.2026</div>
                <div class="pubcal_location"><a>Flugplatz Leck (ETNL)</a></div>
                <div class="pubcal_cidname">LSV Nord e.V.</div>
              </td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    const url = "https://vereinsflieger.de/publiccalendar/?category=3";
    const events = parseVereinsfliegerPage(html, url, SOURCE);
    expect(events.length).toBe(1);
    expect(events[0].startDate).toBe("2026-08-01T00:00:00.000Z");
    expect(events[0].endDate).toBe("2026-08-15T00:00:00.000Z");
    expect(events[0].icaoCode).toBe("ETNL");
    expect(events[0].venueName).toBe("Flugplatz Leck");
    expect(events[0].categoryCode).toBe("flying-camp");
  });

  it("skips month-header rows that have no pubcal_title", () => {
    const html = `
      <html><body>
        <table>
          <tbody>
            <tr><td colspan="2" style="background-color:#eee">Mai 2026</td></tr>
            <tr><td colspan="2" style="background-color:#eee">Juni 2026</td></tr>
          </tbody>
        </table>
      </body></html>
    `;

    const events = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    expect(events.length).toBe(0);
  });

  it("skips rows with unparseable date ranges", () => {
    const html = `
      <html><body>
        <table>
          <tbody>
            <tr>
              <td>
                <div class="pubcal_title">Broken Event</div>
                <div class="pubcal_daterange icon-clock">laufend</div>
                <div class="pubcal_location"><a>Irgendwo</a></div>
                <div class="pubcal_cidname">Verein</div>
              </td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    const events = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    expect(events.length).toBe(0);
  });

  it("skips rows with no organizer", () => {
    const html = `
      <html><body>
        <table>
          <tbody>
            <tr>
              <td>
                <div class="pubcal_title">Orphan Event</div>
                <div class="pubcal_daterange icon-clock">05.06.2026</div>
                <div class="pubcal_location"><a>Platz</a></div>
              </td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    const events = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    expect(events.length).toBe(0);
  });

  it("generates stable dedup keys — same title+date+organizer → same sourceUrl", () => {
    const html = `
      <html><body>
        <table>
          <tbody>
            <tr>
              <td>
                <div class="pubcal_title">Regelbetrieb</div>
                <div class="pubcal_daterange icon-clock">10.07.2026</div>
                <div class="pubcal_location"><a>EDFE Frankfurt Egelsbach</a></div>
                <div class="pubcal_cidname">LSC Egelsbach</div>
              </td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    const a = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    const b = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    expect(a[0].sourceUrl).toBe(b[0].sourceUrl);
  });

  it("parses multiple events interleaved with month headers", () => {
    const html = `
      <html><body>
        <table>
          <tbody>
            <tr><td colspan="2" style="background-color:#eee">April 2026</td></tr>
            <tr>
              <td>
                <div class="pubcal_title">Event A</div>
                <div class="pubcal_daterange icon-clock">05.04.2026</div>
                <div class="pubcal_location"><a>Venue A</a></div>
                <div class="pubcal_cidname">Verein A</div>
              </td>
            </tr>
            <tr>
              <td>
                <div class="pubcal_title">Event B</div>
                <div class="pubcal_daterange icon-clock">12.04.2026</div>
                <div class="pubcal_location"><a>Venue B</a></div>
                <div class="pubcal_cidname">Verein B</div>
              </td>
            </tr>
            <tr><td colspan="2" style="background-color:#eee">Mai 2026</td></tr>
            <tr>
              <td>
                <div class="pubcal_title">Event C</div>
                <div class="pubcal_daterange icon-clock">03.05.2026</div>
                <div class="pubcal_location"><a>Venue C</a></div>
                <div class="pubcal_cidname">Verein C</div>
              </td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    const events = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    expect(events.length).toBe(3);
    expect(events.map((e) => e.title)).toEqual(["Event A", "Event B", "Event C"]);
  });

  it("returns empty array on empty table", () => {
    const html = `<html><body><table><tbody></tbody></table></body></html>`;
    const events = parseVereinsfliegerPage(html, PAGE_URL, SOURCE);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// synthesizeEventDescription
// ---------------------------------------------------------------------------
describe("synthesizeEventDescription", () => {
  it("joins subtitle, date, venue, organizer with em-dash", () => {
    const description = synthesizeEventDescription({
      sourceId: "x",
      sourceUrl: "x",
      sourceName: "vereinsflieger.de",
      pageUrl: "x",
      sourceCategoryId: 1,
      categoryCode: "seminar",
      title: "Podiumsdiskussion",
      subtitle: "Seminar - Fortbildung",
      dateRangeText: "24.04.2026",
      startDate: "2026-04-24T00:00:00.000Z",
      endDate: "2026-04-24T00:00:00.000Z",
      timezone: "Europe/Berlin",
      country: "DE",
      city: null,
      venueName: "Podium Ost",
      icaoCode: null,
      organizerName: "Luftsportverband Rheinland-Pfalz e.V.",
    });
    expect(description).toBe("Seminar - Fortbildung – 24.04.2026 – Podium Ost – Veranstalter: Luftsportverband Rheinland-Pfalz e.V.");
  });

  it("omits missing pieces gracefully", () => {
    const description = synthesizeEventDescription({
      sourceId: "x",
      sourceUrl: "x",
      sourceName: "vereinsflieger.de",
      pageUrl: "x",
      sourceCategoryId: 6,
      categoryCode: "general",
      title: "Minimal",
      subtitle: null,
      dateRangeText: null,
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-06-01T00:00:00.000Z",
      timezone: "Europe/Berlin",
      country: "DE",
      city: null,
      venueName: "Unbekannt",
      icaoCode: null,
      organizerName: "Verein",
    });
    expect(description).toBe("Unbekannt – Veranstalter: Verein");
  });
});
