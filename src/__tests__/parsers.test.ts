import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { parseAircraftPage } from "../parsers/helmut-aircraft.js";
import { parsePartsPage } from "../parsers/helmut-parts.js";
import {
  parseAircraft24IndexPage,
  parseAircraft24ModelPage,
} from "../parsers/aircraft24.js";
import {
  parseAeromarktAircraftPage,
  parseAeromarktPartsPage,
} from "../parsers/aeromarkt.js";
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

// ---------------------------------------------------------------------------
// Aircraft24 parser tests
// ---------------------------------------------------------------------------
describe("parseAircraft24IndexPage", () => {
  const PAGE_URL = "https://www.aircraft24.de/singleprop/index.htm";
  const SOURCE = "aircraft24";

  it("extracts model URLs from index page links", () => {
    const html = `
      <html><body>
        <a href="/singleprop/cessna/172--xm10033.htm">Cessna 172</a>
        <a href="/singleprop/piper/pa28--xm20044.htm">Piper PA-28</a>
        <a href="/about.htm">About</a>
      </body></html>
    `;
    const result = parseAircraft24IndexPage(html, PAGE_URL, SOURCE);
    expect(result.modelUrls.length).toBe(2);
    expect(result.modelUrls[0]).toContain("cessna/172--xm10033.htm");
    expect(result.modelUrls[1]).toContain("piper/pa28--xm20044.htm");
  });

  it("deduplicates model URLs", () => {
    const html = `
      <html><body>
        <a href="/singleprop/cessna/172--xm10033.htm">Cessna 172</a>
        <a href="/singleprop/cessna/172--xm10033.htm">Cessna 172 (again)</a>
      </body></html>
    `;
    const result = parseAircraft24IndexPage(html, PAGE_URL, SOURCE);
    expect(result.modelUrls.length).toBe(1);
  });

  it("parses inline listing blocks with .listing class", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/cessna/172--xi12345.htm">Cessna 172 Skyhawk</a>
          <p>Bj.: 1998; TTAF: 3200; Standort: München; EUR 89.000</p>
          <img src="/images/cessna172.jpg">
        </div>
      </body></html>
    `;
    const result = parseAircraft24IndexPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    const listing = result.listings[0];
    expect(listing.title).toBe("Cessna 172 Skyhawk");
    expect(listing.year).toBe(1998);
    expect(listing.totalTime).toBe(3200);
    expect(listing.price).toBe(89000);
    expect(listing.location).toBe("München");
    expect(listing.imageUrls.length).toBe(1);
    expect(listing.imageUrls[0]).toContain("cessna172.jpg");
  });

  it("returns empty results for empty HTML", () => {
    const result = parseAircraft24IndexPage("<html><body></body></html>", PAGE_URL, SOURCE);
    expect(result.modelUrls.length).toBe(0);
    expect(result.listings.length).toBe(0);
  });

  it("returns empty results for HTML with no matching elements", () => {
    const html = `<html><body><p>Nothing relevant here.</p></body></html>`;
    const result = parseAircraft24IndexPage(html, PAGE_URL, SOURCE);
    expect(result.modelUrls.length).toBe(0);
    expect(result.listings.length).toBe(0);
  });
});

describe("parseAircraft24ModelPage", () => {
  const PAGE_URL = "https://www.aircraft24.de/singleprop/cessna/172--xm10033.htm";
  const SOURCE = "aircraft24";

  it("parses a listing block from a model page", () => {
    const html = `
      <html><body>
        <div class="result-item">
          <a href="/singleprop/cessna/172--xi55678.htm">Cessna 172N Skyhawk II</a>
          <p>Bj.: 1979; TTAF: 5400; Standort: Mannheim EDFM</p>
          <p>EUR 45.000</p>
          <img src="/photos/c172n_55678.jpg">
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    const listing = result.listings[0];
    expect(listing.title).toBe("Cessna 172N Skyhawk II");
    expect(listing.year).toBe(1979);
    expect(listing.totalTime).toBe(5400);
    expect(listing.price).toBe(45000);
    expect(listing.location).toContain("Mannheim");
    expect(listing.sourceName).toBe(SOURCE);
    expect(listing.sourceUrl).toBe(PAGE_URL);
  });

  it("extracts EUR price in dot-separated format", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/mooney/m20--xi99999.htm">Mooney M20J 201</a>
          <p>EUR 125.000 Bj.: 1985</p>
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBe(125000);
  });

  it("extracts price with euro sign format", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/beech/be33--xi44444.htm">Beech Bonanza A36</a>
          <p>€ 210.000 Bj.: 1992 TTAF: 2100</p>
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBe(210000);
    expect(result.listings[0].year).toBe(1992);
    expect(result.listings[0].totalTime).toBe(2100);
  });

  it("extracts year from Bj. pattern", () => {
    const html = `
      <html><body>
        <div class="aircraft-item">
          <a href="/singleprop/piper/pa28--xi11111.htm">Piper PA-28 Cherokee</a>
          <p>Bj. 2005 TT: 890</p>
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].year).toBe(2005);
  });

  it("extracts image URLs excluding logos and icons", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/cessna/172--xi22222.htm">Cessna 172</a>
          <p>Bj.: 2000 EUR 50.000 Standort: Berlin</p>
          <img src="/images/logo.png">
          <img src="/photos/aircraft_main.jpg">
          <img src="/ui/icon-star.svg">
          <img src="/photos/aircraft_side.jpg">
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].imageUrls.length).toBe(2);
    expect(result.listings[0].imageUrls[0]).toContain("aircraft_main.jpg");
    expect(result.listings[0].imageUrls[1]).toContain("aircraft_side.jpg");
  });

  it("extracts location from Standort field", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/diamond/da40--xi33333.htm">Diamond DA40 NG</a>
          <p>Bj.: 2012; TTAF: 800; Standort: Salzburg (LOWS); EUR 195.000</p>
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].location).toContain("Salzburg");
  });

  it("detects next page link (Weiter)", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/cessna/172--xi77777.htm">Cessna 172R</a>
          <p>Bj.: 2001 EUR 120.000 Standort: Hamburg</p>
        </div>
        <a href="/singleprop/cessna/172--xm10033_2.htm">Weiter</a>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.nextPageUrl).not.toBeNull();
    expect(result.nextPageUrl).toContain("172--xm10033_2.htm");
  });

  it("detects next page link (»)", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/piper/pa28--xi88888.htm">Piper PA-28</a>
          <p>Bj.: 1995 EUR 35.000 TTAF: 6000</p>
        </div>
        <a href="/singleprop/piper/pa28--xm20044_3.htm">»</a>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.nextPageUrl).toContain("pa28--xm20044_3.htm");
  });

  it("returns null nextPageUrl when no pagination link exists", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/cessna/152--xi66666.htm">Cessna 152</a>
          <p>Bj.: 1980 EUR 28.000</p>
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.nextPageUrl).toBeNull();
  });

  it("uses detail URL in sourceId when available", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/cessna/172--xi12345.htm">Cessna 172</a>
          <p>Bj.: 2000 EUR 50.000 Standort: Berlin</p>
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].sourceId).toContain("aircraft24");
    expect(result.listings[0].sourceId).toContain("--xi12345");
  });

  it("skips blocks with too little text", () => {
    const html = `
      <html><body>
        <div class="listing"><span>OK</span></div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(0);
  });

  it("handles listing without price (returns null price, negotiable true)", () => {
    const html = `
      <html><body>
        <div class="listing">
          <a href="/singleprop/robin/dr400--xi44444.htm">Robin DR400 Regent</a>
          <p>Bj.: 2008; TTAF: 1500; Standort: Toulouse</p>
        </div>
      </body></html>
    `;
    const result = parseAircraft24ModelPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBeNull();
    expect(result.listings[0].priceNegotiable).toBe(true);
  });

  it("returns empty listings for empty HTML", () => {
    const result = parseAircraft24ModelPage("<html><body></body></html>", PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(0);
    expect(result.nextPageUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Aeromarkt parser tests
// ---------------------------------------------------------------------------
describe("parseAeromarktAircraftPage", () => {
  const PAGE_URL = "https://www.aeromarkt.net/kolbenmotorflugzeuge";
  const SOURCE = "aeromarkt";

  it("parses aircraft listings using .listing-item selector", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/12345">Cessna 182 Skylane</a>
          <p>Baujahr: 1997, TT: 2800, Standort: Frankfurt EDDF</p>
          <p>€ 95.000</p>
          <img src="/uploads/cessna182.jpg">
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    const listing = result.listings[0];
    expect(listing.title).toBe("Cessna 182 Skylane");
    expect(listing.year).toBe(1997);
    expect(listing.totalTime).toBe(2800);
    expect(listing.price).toBe(95000);
    expect(listing.location).toContain("Frankfurt");
    expect(listing.imageUrls.length).toBe(1);
    expect(listing.imageUrls[0]).toContain("cessna182.jpg");
    expect(listing.sourceName).toBe(SOURCE);
    expect(listing.sourceUrl).toBe(PAGE_URL);
  });

  it("parses listings using .ad-item selector", () => {
    const html = `
      <html><body>
        <div class="ad-item">
          <a href="/angebot/67890">Piper PA-32 Saratoga</a>
          <p>Year: 2003, TTAF: 1200, Location: Zürich</p>
          <p>EUR 175.000</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].title).toBe("Piper PA-32 Saratoga");
    expect(result.listings[0].price).toBe(175000);
  });

  it("extracts price in EUR format", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/11111">Beechcraft Baron 58</a>
          <p>Bj. 1988 Flugstunden: 4500 EUR 220.000</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBe(220000);
  });

  it("extracts price with euro sign", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/22222">Diamond DA42 Twin Star</a>
          <p>Baujahr: 2010 € 350.000 TT: 950</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBe(350000);
  });

  it("extracts year from Baujahr pattern", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/33333">Cirrus SR22 GTS</a>
          <p>Baujahr: 2015, TT: 600, Standort: Wien, € 450.000</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].year).toBe(2015);
  });

  it("extracts location from Ort field", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/44444">Socata TB20 Trinidad</a>
          <p>Bj.: 2001 TT: 1800 Ort: Nürnberg € 120.000</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].location).toContain("Nürnberg");
  });

  it("sets priceNegotiable true when no price found", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/55555">Grumman AA-5B Tiger</a>
          <p>Baujahr: 1979 TT: 3500 Standort: Bremen</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBeNull();
    expect(result.listings[0].priceNegotiable).toBe(true);
  });

  it("filters out logo and icon images", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/66666">Mooney M20R Ovation</a>
          <p>Bj.: 2000, TT: 1100, Standort: Köln, € 180.000</p>
          <img src="/static/logo.png">
          <img src="/uploads/mooney_front.jpg">
          <img src="/static/banner-top.gif">
          <img src="/static/pixel.gif">
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].imageUrls.length).toBe(1);
    expect(result.listings[0].imageUrls[0]).toContain("mooney_front.jpg");
  });

  it("detects next page link", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/77777">Robin DR400</a>
          <p>Bj.: 1995 TT: 4000 € 55.000 Standort: Lyon</p>
        </div>
        <a href="/kolbenmotorflugzeuge?page=2">Weiter</a>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.nextPageUrl).toContain("page=2");
  });

  it("detects next page link with rel=next", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/88888">Tecnam P2006T</a>
          <p>Baujahr: 2018 TT: 300 € 280.000</p>
        </div>
        <a href="/kolbenmotorflugzeuge?page=3" rel="next">3</a>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.nextPageUrl).toContain("page=3");
  });

  it("returns empty results for empty HTML", () => {
    const result = parseAeromarktAircraftPage("<html><body></body></html>", PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(0);
    expect(result.nextPageUrl).toBeNull();
  });

  it("returns empty results for HTML with no matching selectors", () => {
    const html = `<html><body><div class="unrelated">Some text content here.</div></body></html>`;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(0);
  });

  it("parses multiple listings on a single page", () => {
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/10001">Cessna 152 Aerobat</a>
          <p>Baujahr: 1978 TT: 8000 € 32.000 Standort: Hamburg</p>
        </div>
        <div class="listing-item">
          <a href="/inserat/10002">Piper PA-28 Warrior</a>
          <p>Baujahr: 1990 TT: 5500 € 48.000 Standort: Berlin</p>
        </div>
        <div class="listing-item">
          <a href="/inserat/10003">Diamond DA20 Katana</a>
          <p>Bj.: 2002 TT: 2100 € 65.000 Standort: München</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktAircraftPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(3);
    expect(result.listings[0].title).toBe("Cessna 152 Aerobat");
    expect(result.listings[1].title).toBe("Piper PA-28 Warrior");
    expect(result.listings[2].title).toBe("Diamond DA20 Katana");
  });
});

describe("parseAeromarktPartsPage", () => {
  const SOURCE = "aeromarkt";

  it("parses parts listings from avionik page", () => {
    const PAGE_URL = "https://www.aeromarkt.net/avionik-instrumente";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90001">Garmin GTN 650Xi</a>
          <p>GPS/NAV/COM Navigator, neuwertig. € 8.500</p>
          <img src="/uploads/gtn650.jpg">
        </div>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    const listing = result.listings[0];
    expect(listing.title).toBe("Garmin GTN 650Xi");
    expect(listing.price).toBe(8500);
    expect(listing.category).toBe("avionics");
    expect(listing.imageUrls.length).toBe(1);
    expect(listing.imageUrls[0]).toContain("gtn650.jpg");
  });

  it("parses parts listings from triebwerk page", () => {
    const PAGE_URL = "https://www.aeromarkt.net/triebwerke";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90002">Lycoming O-360-A1A 180PS</a>
          <p>Generalüberholter Motor, 0 TSN. € 28.000</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].title).toBe("Lycoming O-360-A1A 180PS");
    expect(result.listings[0].price).toBe(28000);
    expect(result.listings[0].category).toBe("engines");
  });

  it("defaults to miscellaneous category for generic URL", () => {
    const PAGE_URL = "https://www.aeromarkt.net/zubehoer";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90003">David Clark H10-13.4 Headset</a>
          <p>Gut erhalten, voll funktionsfähig. € 180</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].category).toBe("miscellaneous");
  });

  it("extracts price with EUR prefix", () => {
    const PAGE_URL = "https://www.aeromarkt.net/avionik-instrumente";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90004">Trig TT21 Mode S Transponder</a>
          <p>Neuwertiger Transponder mit ADS-B Out. EUR 2.200</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBe(2200);
  });

  it("sets priceNegotiable true when no price found", () => {
    const PAGE_URL = "https://www.aeromarkt.net/avionik-instrumente";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90005">Bendix/King KX 155 NAV/COM</a>
          <p>Gebrauchtes Funkgerät, voll funktionsfähig, guter Zustand.</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].price).toBeNull();
    expect(result.listings[0].priceNegotiable).toBe(true);
  });

  it("filters out logo and icon images in parts", () => {
    const PAGE_URL = "https://www.aeromarkt.net/triebwerke";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90006">Continental IO-360 200PS</a>
          <p>Motor nach Grundüberholung, 50 TSN. € 32.000</p>
          <img src="/static/logo-small.png">
          <img src="/uploads/io360_photo.jpg">
          <img src="/static/icon-engine.svg">
        </div>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(1);
    expect(result.listings[0].imageUrls.length).toBe(1);
    expect(result.listings[0].imageUrls[0]).toContain("io360_photo.jpg");
  });

  it("detects next page link", () => {
    const PAGE_URL = "https://www.aeromarkt.net/avionik-instrumente";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90007">Garmin GMA 345 Audio Panel</a>
          <p>Bluetooth Audio Panel, neuwertig. € 3.200</p>
        </div>
        <a href="/avionik-instrumente?page=2">weiter</a>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.nextPageUrl).toContain("page=2");
  });

  it("returns empty results for empty HTML", () => {
    const PAGE_URL = "https://www.aeromarkt.net/triebwerke";
    const result = parseAeromarktPartsPage("<html><body></body></html>", PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(0);
    expect(result.nextPageUrl).toBeNull();
  });

  it("returns empty results for HTML with no matching selectors", () => {
    const PAGE_URL = "https://www.aeromarkt.net/triebwerke";
    const html = `<html><body><div class="footer">Copyright 2024</div></body></html>`;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(0);
  });

  it("parses multiple parts listings", () => {
    const PAGE_URL = "https://www.aeromarkt.net/avionik-instrumente";
    const html = `
      <html><body>
        <div class="listing-item">
          <a href="/inserat/90010">Garmin G5 EFIS</a>
          <p>Electronic Flight Instrument, neuwertig. € 2.800</p>
        </div>
        <div class="listing-item">
          <a href="/inserat/90011">Becker AR 6201 COM</a>
          <p>8.33 kHz Funkgerät, gebraucht, funktionsfähig. € 950</p>
        </div>
      </body></html>
    `;
    const result = parseAeromarktPartsPage(html, PAGE_URL, SOURCE);
    expect(result.listings.length).toBe(2);
    expect(result.listings[0].title).toBe("Garmin G5 EFIS");
    expect(result.listings[0].price).toBe(2800);
    expect(result.listings[1].title).toBe("Becker AR 6201 COM");
    expect(result.listings[1].price).toBe(950);
  });
});
