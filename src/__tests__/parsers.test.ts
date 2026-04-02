import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { parseAircraftPage } from "../parsers/helmut-aircraft.js";
import { parsePartsPage } from "../parsers/helmut-parts.js";
import {
  extractTitle,
  extractAirfield,
  extractCity,
  extractPriceFromText,
} from "../parsers/shared.js";

const PAGE_URL = "https://www.helmuts-ul-seiten.de/verkauf1a.html";
const SOURCE_NAME = "helmut-ul";

describe("parseAircraftPage", () => {
  it("parses a minimal aircraft listing block", () => {
    const html = `
      <html><body>
        <p>Navigation links here</p>
        <hr>
        <b>Comco Ikarus C42 B</b><br>
        15.03.2024<br>
        Baujahr: 2018<br>
        Motor: Rotax 912ULS 100 PS<br>
        TT: 450 Stunden<br>
        MTOW: 472,5 kg<br>
        Rettung: Junkers Magnum 450<br>
        JNP: 06/2025<br>
        Standort: 86899 Landsberg am Lech<br>
        Sehr gepflegtes UL mit vollem Avionikpaket und aktuellem Rettungssystem.
        Immer hangariert.<br>
        Preis: €35.500 VB<br>
        Tel.: 0171/1234567<br>
        <a href="mailto:pilot%40example.de">Email</a><br>
        <img src="images/c42.jpg" width="400" height="300">
        <hr>
        <p>Short footer text that should be ignored</p>
      </body></html>
    `;

    const listings = parseAircraftPage(html, PAGE_URL, SOURCE_NAME);

    expect(listings.length).toBe(1);
    const listing = listings[0];

    expect(listing.title).toBe("Comco Ikarus C42 B");
    expect(listing.postedDate).toBe("2024-03-15");
    expect(listing.year).toBe(2018);
    // Engine regex captures everything after "Motor:" until bullet or newline,
    // but cleanText collapses all whitespace into a single line, so it captures more
    expect(listing.engine).toContain("Rotax 912ULS 100 PS");
    expect(listing.totalTime).toBe(450);
    expect(listing.mtow).toBe(472.5);
    // Same as engine: regex captures until bullet/newline, but cleanText removes newlines
    expect(listing.rescueSystem).toContain("Junkers Magnum 450");
    expect(listing.price).toBe(35500);
    expect(listing.priceNegotiable).toBe(true);
    expect(listing.contactEmail).toBe("pilot@example.de");
    expect(listing.contactPhone).toBe("0171/1234567");
    expect(listing.sourceUrl).toBe(PAGE_URL);
    expect(listing.sourceName).toBe(SOURCE_NAME);
    expect(listing.imageUrls.length).toBe(1);
    expect(listing.imageUrls[0]).toContain("c42.jpg");
  });

  it("parses multiple listings separated by <hr>", () => {
    const html = `
      <html><body>
        <hr>
        <b>Aeropract A22 Foxbat</b><br>
        10.01.2024<br>
        Baujahr: 2015<br>
        Motor: Rotax 912UL 80 PS<br>
        TT: 820 Stunden<br>
        MTOW: 472,5 kg<br>
        Sehr gut erhalten, regelmäßig gewartet. Immer hangariert und gepflegt.<br>
        Preis: €28.000<br>
        Tel.: 0160/9876543<br>
        <hr>
        <b>FK9 Mark IV</b><br>
        22.02.2024<br>
        Baujahr: 2020<br>
        Motor: Rotax 912iS 100 PS<br>
        TT: 180<br>
        MTOW: 600 kg<br>
        Neuwertig, kaum geflogen. Vollausstattung inklusive Rettungssystem.<br>
        Preis: €65.000 FP<br>
        <a href="mailto:info%40fk9-owner.de">Email</a><br>
        <hr>
      </body></html>
    `;

    const listings = parseAircraftPage(html, PAGE_URL, SOURCE_NAME);
    expect(listings.length).toBe(2);
    expect(listings[0].title).toBe("Aeropract A22 Foxbat");
    expect(listings[0].year).toBe(2015);
    expect(listings[1].title).toBe("FK9 Mark IV");
    expect(listings[1].year).toBe(2020);
    expect(listings[1].priceNegotiable).toBe(false);
  });

  it("skips navigation blocks", () => {
    const html = `
      <html><body>
        <hr>
        <p>Startseite - Navigation - HOME</p>
        <hr>
        <b>Pipistrel Virus SW</b><br>
        01.06.2024<br>
        Baujahr: 2019<br>
        Motor: Rotax 912iS Sport 100 PS<br>
        TT: 300 Stunden<br>
        MTOW: 472,5 kg<br>
        Top gepflegt, wenig Stunden, Garmin G3X Touch. Preis: €89.000 VB<br>
        <hr>
      </body></html>
    `;

    const listings = parseAircraftPage(html, PAGE_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].title).toBe("Pipistrel Virus SW");
  });

  it("generates sourceId with date", () => {
    const html = `
      <html><body>
        <hr>
        <b>Remos GX</b><br>
        05.04.2024<br>
        Baujahr: 2016<br>
        Motor: Rotax 912ULS<br>
        TT: 500 Stunden<br>
        MTOW: 600 kg<br>
        Gut erhaltenes UL in sehr gutem Zustand, regelmäßig gewartet.<br>
        €42.000 VB<br>
        <hr>
      </body></html>
    `;
    const listings = parseAircraftPage(html, PAGE_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].sourceId).toContain(PAGE_URL);
    expect(listings[0].sourceId).toContain("2024-04-05");
  });

  it("extracts location from Standort pattern", () => {
    const html = `
      <html><body>
        <hr>
        <b>TL Ultralight Stream</b><br>
        01.05.2024<br>
        Baujahr: 2021<br>
        Motor: Rotax 912iS<br>
        TT: 120 Stunden<br>
        MTOW: 600 kg<br>
        Standort: Raum Stuttgart, gut erhalten und gepflegt. Top-Zustand.<br>
        €75.000<br>
        <hr>
      </body></html>
    `;
    const listings = parseAircraftPage(html, PAGE_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].location).not.toBeNull();
  });
});

describe("parsePartsPage", () => {
  const PARTS_URL = "https://www.helmuts-ul-seiten.de/verkauf2.html";

  it("parses a minimal parts listing", () => {
    // Parts blocks need > 30 chars of text content to pass the splitIntoBlocks filter
    const html = `
      <html><body>
        <hr>
        <b>Garmin GTX 335 Transponder</b><br>
        20.03.2024<br>
        Zustand: neuwertig, originalverpackt, voll funktionsfähig und getestet. Inklusive Einbaurahmen und Verkabelung.<br>
        TT: 120 Stunden<br>
        Preis: €1.800 VB<br>
        Tel.: 0172/5551234<br>
        <a href="mailto:avionik%40test.de">Email</a><br>
        <img src="images/gtx335.jpg" width="300" height="200">
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);

    expect(listings.length).toBe(1);
    const listing = listings[0];
    expect(listing.title).toBe("Garmin GTX 335 Transponder");
    expect(listing.postedDate).toBe("2024-03-20");
    expect(listing.price).toBe(1800);
    expect(listing.priceNegotiable).toBe(true);
    expect(listing.contactEmail).toBe("avionik@test.de");
    expect(listing.contactPhone).toBe("0172/5551234");
    expect(listing.imageUrls.length).toBe(1);
  });

  it("detects avionics category from header block", () => {
    // Category header must have > 30 chars text to pass splitIntoBlocks filter
    // and < 100 chars to be detected as a category header by detectCategory
    const html = `
      <html><body>
        <hr>
        <b>Avionik / Navigationsgeräte und Funkgeräte</b>
        <hr>
        <b>Garmin GNS 430W GPS/NAV/COM</b><br>
        15.02.2024<br>
        Zustand: gebraucht, voll funktionsfähig, gut erhalten und gepflegt. Komplett mit Antenne und Einbaurahmen.<br>
        TT: 800 Stunden<br>
        €2.500 VB<br>
        Tel.: 0171/9998877<br>
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].category).toBe("avionics");
  });

  it("detects engines category", () => {
    const html = `
      <html><body>
        <hr>
        <b>Motoren und Triebwerke zu verkaufen</b>
        <hr>
        <b>Rotax 912ULS 100 PS komplett</b><br>
        10.01.2024<br>
        TT: 1200 Stunden<br>
        Zustand: gebraucht, revision steht bald an. Gut erhalten und funktionstüchtig. Komplett mit Auspuff und Luftfilter.<br>
        €8.500<br>
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].category).toBe("engines");
  });

  it("detects rescue category", () => {
    const html = `
      <html><body>
        <hr>
        <b>Rettungsgeräte und Rettungssysteme zu verkaufen</b>
        <hr>
        <b>Junkers Magnum Softpack 450</b><br>
        05.03.2024<br>
        Zustand: neuwertig, 2023 gepackt, nie ausgelöst, in sehr gutem Zustand. Inklusive Einbauanleitung und Zertifikat.<br>
        €1.200<br>
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].category).toBe("rescue");
  });

  it("defaults to miscellaneous category", () => {
    const html = `
      <html><body>
        <hr>
        <b>Hangar-Abdeckplane für Ikarus C42</b><br>
        01.04.2024<br>
        Zustand: gut erhalten und gepflegt, wenig benutzt, passt auf Ikarus C42. Inklusive Spannseile und Heringe für Outdoor-Nutzung.<br>
        €350<br>
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].category).toBe("miscellaneous");
  });

  it("detects miscellaneous category from Sonstiges header", () => {
    const html = `
      <html><body>
        <hr>
        <b>Motoren und Triebwerke zu verkaufen</b>
        <hr>
        <b>Rotax 582 komplett mit Auspuff</b><br>
        10.01.2024<br>
        Betriebsstunden: 600, gebraucht, gut erhalten und funktionstüchtig. Versand möglich. Inklusive Motorträger und Kabelbaum.<br>
        €3.000<br>
        <hr>
        <b>Sonstiges / Diverses und Zubehör für UL</b>
        <hr>
        <b>UL Hangarplatz EDML frei ab sofort</b><br>
        15.02.2024<br>
        Hangarplatz frei ab sofort. Gut gelegen am Platz. Strom und Wasser vorhanden. Platz für ein UL bis 15m Spannweite.<br>
        €180 / Monat VB<br>
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);
    expect(listings.length).toBe(2);
    expect(listings[0].category).toBe("engines");
    expect(listings[1].category).toBe("miscellaneous");
  });

  it("skips navigation blocks in parts page", () => {
    const html = `
      <html><body>
        <hr>
        <p>Startseite - Impressum - HOME</p>
        <hr>
        <b>BRS Rettungsrakete komplett mit Auslöser</b><br>
        01.06.2024<br>
        Zustand: neuwertig, nie ausgelöst, sehr guter Zustand, voll funktionsfähig. Inklusive Einbausatz und Dokumentation.<br>
        €900 VB<br>
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
  });

  it("extracts VAT status when present", () => {
    const html = `
      <html><body>
        <hr>
        <b>Funkgerät Trig TY91 komplett mit Antenne</b><br>
        10.04.2024<br>
        Zustand: neu, originalverpackt, nie benutzt, noch in der Verpackung. Inklusive Einbaurahmen und Dokumentation.<br>
        Preis: €1.200<br>
        MWSt ausweisbar<br>
        <hr>
      </body></html>
    `;

    const listings = parsePartsPage(html, PARTS_URL, SOURCE_NAME);
    expect(listings.length).toBe(1);
    expect(listings[0].vatIncluded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 1: Date prefix stripping (via extractTitle)
// ---------------------------------------------------------------------------
describe("extractTitle – date prefix stripping", () => {
  /** Helper: build a cheerio block with bold text and return the extracted title. */
  function titleFromBold(boldText: string): string {
    const html = `<div><b>${boldText}</b></div>`;
    const $block = cheerio.load(html);
    const text = $block.text();
    return extractTitle($block, text);
  }

  it("strips DD.MM.YYYY prefix", () => {
    expect(titleFromBold("17.01.2025 Breezer Sport")).toBe("Breezer Sport");
  });

  it("strips D.MM.YYYY prefix (single-digit day)", () => {
    expect(titleFromBold("3.04.2025 RANS S-10 Sakota")).toBe("RANS S-10 Sakota");
  });

  it("strips 'Update DD.MM.YYYY' prefix", () => {
    expect(titleFromBold("Update 22.06.2025 Pioneer 300")).toBe("Pioneer 300");
  });

  it("returns title unchanged when there is no date prefix", () => {
    expect(titleFromBold("Cessna 172 Skyhawk")).toBe("Cessna 172 Skyhawk");
  });

  it("returns empty string for date-only title", () => {
    expect(titleFromBold("15.08.2025")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Test 2: ICAO code extraction
// ---------------------------------------------------------------------------
describe("extractAirfield", () => {
  it("extracts airfield name and ICAO from 'Flugplatz Name ICAO'", () => {
    const result = extractAirfield("Flugplatz Strausberg EDAZ");
    expect(result.name).toBe("Strausberg");
    expect(result.icao).toBe("EDAZ");
  });

  it("extracts ICAO from 'stationiert am ICAO'", () => {
    const result = extractAirfield("stationiert am EDMT");
    expect(result.icao).toBe("EDMT");
  });

  it("extracts airfield name without ICAO", () => {
    const result = extractAirfield("Heimatflugplatz: Borkenberge");
    expect(result.name).toBe("Borkenberge");
    expect(result.icao).toBeNull();
  });

  it("extracts ICAO when it appears before city name", () => {
    const result = extractAirfield("LSZB Bern-Belp");
    expect(result.icao).toBe("LSZB");
  });

  it("returns nulls when no airfield info present", () => {
    const result = extractAirfield("Schönes Flugzeug zu verkaufen");
    expect(result.name).toBeNull();
    expect(result.icao).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 3: City extraction
// ---------------------------------------------------------------------------
describe("extractCity", () => {
  it("extracts city from 'Standort: City'", () => {
    expect(extractCity("Standort: Augsburg")).toBe("Augsburg");
  });

  it("extracts city from postal code pattern", () => {
    expect(extractCity("86150 Augsburg")).toBe("Augsburg");
  });

  it("extracts city from 'Raum City'", () => {
    expect(extractCity("Raum Frankfurt")).toBe("Frankfurt");
  });

  it("returns null for null input", () => {
    expect(extractCity(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Price negotiable detection
// ---------------------------------------------------------------------------
describe("extractPriceFromText – negotiable detection", () => {
  it("detects 'Preis verhandelbar' as negotiable with no amount", () => {
    const result = extractPriceFromText("Preis verhandelbar");
    expect(result.amount).toBeNull();
    expect(result.negotiable).toBe(true);
  });

  it("detects 'Verhandlungsbasis' as negotiable with no amount", () => {
    const result = extractPriceFromText("Verhandlungsbasis");
    expect(result.amount).toBeNull();
    expect(result.negotiable).toBe(true);
  });

  it("detects 'Preis auf Anfrage' as negotiable with no amount", () => {
    const result = extractPriceFromText("Preis auf Anfrage");
    expect(result.amount).toBeNull();
    expect(result.negotiable).toBe(true);
  });

  it("extracts amount and detects VB suffix as negotiable", () => {
    const result = extractPriceFromText("€35.500 VB");
    expect(result.amount).toBe(35500);
    expect(result.negotiable).toBe(true);
  });

  it("returns no price and not negotiable for unrelated text", () => {
    const result = extractPriceFromText("No price info here");
    expect(result.amount).toBeNull();
    expect(result.negotiable).toBe(false);
  });
});
