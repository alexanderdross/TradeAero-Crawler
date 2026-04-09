import * as cheerio from "cheerio";
import { cleanText, generateSourceId } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import type { ParsedAircraftListing } from "../types.js";

/**
 * Parse aircraft listings from aircraft24.de.
 *
 * Site structure:
 * - Category index pages: /singleprop/index.htm, /multiprop/index.htm, etc.
 * - Model pages: /singleprop/cessna/172--xm10033.htm (paginated)
 * - Detail pages: /singleprop/cessna/172--xi12345.htm
 *
 * Listing format on index/model pages:
 *   [Aircraft Model] [Price]
 *   Bj.: [Year]; TTAF: [Hours]; Standort: [Location]; [Registration]
 *
 * Strategy: Parse index pages to find model links, then parse each model
 * page for individual listings. Extract detail page URLs for full data.
 *
 * TODO: Refine selectors once we can test against live HTML with Bright Data proxy.
 */
export function parseAircraft24IndexPage(
  html: string,
  pageUrl: string,
  sourceName: string
): { modelUrls: string[]; listings: ParsedAircraftListing[] } {
  const $ = cheerio.load(html);
  const baseUrl = new URL(pageUrl).origin;
  const modelUrls: string[] = [];
  const listings: ParsedAircraftListing[] = [];

  // Extract model/manufacturer links from index pages
  // aircraft24.de uses links ending in --xm[id].htm for model listing pages
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.includes("--xm") && href.endsWith(".htm")) {
      const absoluteUrl = href.startsWith("http") ? href : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
      if (!modelUrls.includes(absoluteUrl)) {
        modelUrls.push(absoluteUrl);
      }
    }
  });

  // Also try to parse any inline listing data on the page
  // Many index pages show summary listings directly
  const blocks = extractListingBlocks($, html);
  for (let i = 0; i < blocks.length; i++) {
    try {
      const listing = parseListingBlock(blocks[i], i, pageUrl, sourceName);
      if (listing) listings.push(listing);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse aircraft24 block ${i}`, { pageUrl, error: msg });
    }
  }

  logger.info(`Parsed aircraft24 page`, { pageUrl, modelUrls: modelUrls.length, listings: listings.length });
  return { modelUrls, listings };
}

/**
 * Parse a model listing page (e.g., /singleprop/cessna/172--xm10033.htm)
 */
export function parseAircraft24ModelPage(
  html: string,
  pageUrl: string,
  sourceName: string
): { listings: ParsedAircraftListing[]; nextPageUrl: string | null } {
  const $ = cheerio.load(html);
  const listings: ParsedAircraftListing[] = [];

  const blocks = extractListingBlocks($, html);
  for (let i = 0; i < blocks.length; i++) {
    try {
      const listing = parseListingBlock(blocks[i], i, pageUrl, sourceName);
      if (listing) listings.push(listing);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse aircraft24 listing ${i}`, { pageUrl, error: msg });
    }
  }

  // Check for next page ("Weiter" or page number links)
  let nextPageUrl: string | null = null;
  $("a").each((_, el) => {
    const text = $(el).text().trim();
    if (text === "Weiter" || text === "»") {
      const href = $(el).attr("href");
      if (href) {
        // Use URL resolution to preserve the subdirectory path.
        // e.g. pageUrl = "/singleprop/cessna/172--xm10033.htm"
        //       href   = "172--xm10033--xo2.htm" (relative, no leading /)
        // → resolves to "/singleprop/cessna/172--xm10033--xo2.htm" ✓
        // Previously used `origin + href` which stripped the path, giving a 404.
        nextPageUrl = new URL(href, pageUrl).href;
      }
    }
  });

  logger.info(`Parsed aircraft24 model page`, { pageUrl, listings: listings.length, hasNext: !!nextPageUrl });
  return { listings, nextPageUrl };
}

function extractListingBlocks($: cheerio.CheerioAPI, _html: string): string[] {
  const blocks: string[] = [];

  // aircraft24.de uses .listing class or table rows for listings
  $(".listing, .result-item, tr.item, .aircraft-item").each((_, el) => {
    const blockHtml = $.html(el);
    if (blockHtml.length > 50) blocks.push(blockHtml);
  });

  // Fallback: look for links containing --xi (detail page links)
  if (blocks.length === 0) {
    $("a[href*='--xi']").each((_, el) => {
      const parent = $(el).parent();
      const blockHtml = $.html(parent);
      if (blockHtml.length > 30) blocks.push(blockHtml);
    });
  }

  return blocks;
}

function parseListingBlock(
  blockHtml: string,
  index: number,
  pageUrl: string,
  sourceName: string
): ParsedAircraftListing | null {
  const $ = cheerio.load(blockHtml);
  const text = cleanText($("body").text());

  if (text.length < 20) return null;

  // Extract title (first link text or bold text)
  let title = $("a").first().text().trim() || $("b, strong").first().text().trim() || text.slice(0, 100);
  if (!title || title.length < 3) return null;

  // Clean title: strip embedded metadata that Aircraft24 puts in the listing text
  // Pattern: "Cessna 172€ 89.000Bj.: 2018; TTAF: 1200h; Standort: Deutschland"
  // → "Cessna 172"
  title = title
    .replace(/€\s*[\d.,]+.*$/s, "")                          // Strip everything after price
    .replace(/Preis auf Anfrage.*$/si, "")                    // Strip "Preis auf Anfrage" and after
    .replace(/\bBj\.?\s*:?\s*\d{4}.*$/si, "")                // Strip from year onwards
    .replace(/\bTTAF\b.*$/si, "")                             // Strip from TTAF onwards
    .replace(/\bStandort\b.*$/si, "")                         // Strip from Standort onwards
    .replace(/\bEU versteuert.*$/si, "")                      // Strip EU tax note
    .replace(/\bNettopreis\b.*$/si, "")                       // Strip net price
    .replace(/\bSeriennr\.?\b.*$/si, "")                      // Strip serial number
    .replace(/\bReg\.?\s*Nr\.?\b.*$/si, "")                   // Strip registration
    .replace(/\bJahresnachpr[üu]fung\b.*$/si, "")             // Strip annual inspection
    .replace(/\bTyp:\s*\w+.*$/si, "")                         // Strip "Typ: Single-Prop"
    .replace(/CHF\s*[\d.,]+.*$/si, "")                        // Strip CHF price
    .trim();

  if (!title || title.length < 3) return null;

  // Extract year: "Bj.: 2018" or "Bj. 2018"
  const yearMatch = text.match(/Bj\.?\s*:?\s*(\d{4})/i);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Extract TTAF: "TTAF: 1234" or "TT: 1234" or "TSN: 1234"
  const ttMatch = text.match(/(?:TTAF|TT(?:AF)?|TSN)[:\s]*([\d.,]+)/i);
  const totalTime = ttMatch ? parseFloat(ttMatch[1].replace(/\./g, "").replace(",", ".")) : null;

  // Extract engine hours: "TTE: 1234" or "TSOH: 1234" or "TTSN: 1234" or "Motorstunden: 1234"
  const engineMatch = text.match(/(?:TTE|TSOH|TTSN|Motorstunden|Motor)[:\s]*([\d.,]+)/i);
  const engineHours = engineMatch ? parseFloat(engineMatch[1].replace(/\./g, "").replace(",", ".")) : null;

  // Extract landings/cycles: "LDG: 1234" or "Ldg.: 1234" or "Landungen: 1234"
  const cyclesMatch = text.match(/(?:LDG|Ldg\.?|Landungen|Zyklen)[:\s]*([\d.,]+)/i);
  const cycles = cyclesMatch ? parseInt(cyclesMatch[1].replace(/\./g, ""), 10) : null;

  // Extract annual inspection: "TP: 12/2025" or "JNP: 2025" or "Prüfung: 2025" or "HU: 2025"
  const annualMatch = text.match(/(?:TP|JNP|HU|Jahresnachpr[üu]fung|Prüfung)[:\s]*([\d./]+(?:\s*\d{4})?)/i);
  const annualInspection = annualMatch ? annualMatch[1].trim() : null;

  // Extract price: "EUR 89.000" or "€ 89.000" or "89.000 EUR"
  const priceInfo = extractPrice(text);

  // Extract location: "Standort: München (EDDM)"
  const locationMatch = text.match(/(?:Standort|Location)[:\s]*([^;|\n]+)/i);
  const location = locationMatch ? cleanText(locationMatch[1]) : null;

  // Parse city and ICAO code from location string
  // Patterns: "München (EDDM)", "Strausberg/EDAY", "München"
  let city24: string | null = null;
  let icaoCode24: string | null = null;
  if (location) {
    const icaoParenMatch = location.match(/\(([A-Z]{4})\)/);
    if (icaoParenMatch) {
      icaoCode24 = icaoParenMatch[1];
      city24 = location.replace(/\s*\([A-Z]{4}\)/, "").trim().split(/[/,]/)[0].trim() || null;
    } else {
      const slashIcaoMatch = location.match(/\/([A-Z]{4})$/);
      if (slashIcaoMatch) {
        icaoCode24 = slashIcaoMatch[1];
        city24 = location.replace(/\/[A-Z]{4}$/, "").trim() || null;
      } else {
        city24 = location.split(/[/(,]/)[0].trim() || null;
      }
    }
  }
  // Fallback: scan full text for ICAO codes if not found in location
  if (!icaoCode24) {
    const icaoTextMatch = text.match(/\b((?:ED|LO|LS|EG|LF|EB|LP|LE|LK|EP|EH|LI|EK|ES|EN|EF)[A-Z]{2})\b/);
    if (icaoTextMatch) icaoCode24 = icaoTextMatch[1];
  }
  // Detect country from ICAO prefix
  const ICAO_TO_COUNTRY24: Record<string, string> = {
    ED: "Germany", LO: "Austria", LS: "Switzerland", EG: "United Kingdom",
    LF: "France", EB: "Belgium", LP: "Portugal", LE: "Spain",
    LK: "Czech Republic", EP: "Poland", EH: "Netherlands",
    LI: "Italy", EK: "Denmark", ES: "Sweden", EN: "Norway", EF: "Finland",
  };
  const country24 = icaoCode24 ? (ICAO_TO_COUNTRY24[icaoCode24.substring(0, 2)] ?? null) : null;

  // Extract detail page URL
  let detailUrl: string | null = null;
  $("a[href*='--xi']").each((_, el) => {
    detailUrl = $(el).attr("href") ?? null;
  });

  // Extract images
  const images: string[] = [];
  const baseUrl = new URL(pageUrl).origin;
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (src && !src.includes("logo") && !src.includes("icon") && !src.includes("banner")) {
      const absoluteUrl = src.startsWith("http") ? src : `${baseUrl}${src.startsWith("/") ? "" : "/"}${src}`;
      images.push(absoluteUrl);
    }
  });

  const sourceId = generateSourceId(pageUrl, index, detailUrl ?? undefined);

  // Registration
  const regMatch = text.match(/\b([A-Z]{1,2}-[A-Z0-9]{2,5})\b/);
  const registration = regMatch ? regMatch[1] : null;

  // Serial number
  const serialMatch24 = text.match(/(?:Werk[- ]?Nr\.?|S\/N|Seriennummer|Serial)[:\s]*([A-Z0-9][\w-]{1,20})/i);
  const serialNumber = serialMatch24 ? serialMatch24[1].trim() : null;

  // Airworthy
  let airworthy24: boolean | null = null;
  if (/nicht\s*(?:luft|verkehrs)tüchtig|not\s+airworthy/i.test(text)) airworthy24 = false;
  else if (/(?:luft|verkehrs)tüchtig|airworthy|LTB\s+vorhanden/i.test(text)) airworthy24 = true;

  // Extract manufacturer and category hints from the URL path
  // e.g. /singleprop/diamond/da40-ng--xm12345.htm → category="Single Engine Piston", mfg="diamond"
  const urlSegments = new URL(pageUrl, "https://www.aircraft24.de").pathname.split("/").filter(Boolean);
  const manufacturerHint = urlSegments.length >= 2 ? urlSegments[1].replace(/-/g, " ").trim() : undefined;

  // Map aircraft24 URL category slugs to DB category names
  const AIRCRAFT24_CATEGORY_MAP: Record<string, string> = {
    singleprop:  "Single Engine Piston",
    multiprop:   "Multi Engine Piston",
    turboprop:   "Turboprop",
    jet:         "Jet",
    helicopter:  "Helicopter / Gyrocopter",
    ultralight:  "Ultralight / Light Sport Aircraft (LSA)",
    motorglider: "Glider",
    glider:      "Glider",
  };
  const categoryHint = urlSegments.length >= 1 ? AIRCRAFT24_CATEGORY_MAP[urlSegments[0]] : undefined;

  return {
    sourceId: detailUrl ? `${sourceName}:${detailUrl}` : sourceId,
    sourceUrl: pageUrl,
    sourceName,
    postedDate: null,
    title,
    description: text,
    year,
    engine: null,
    totalTime,
    engineHours,
    cycles,
    mtow: null,
    rescueSystem: null,
    annualInspection,
    dulvRef: null,
    price: priceInfo.amount,
    priceNegotiable: priceInfo.negotiable,
    location,
    city: city24,
    airfieldName: null,
    icaoCode: icaoCode24,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    imageUrls: images,
    registration,
    serialNumber,
    airworthy: airworthy24,
    avionicsText: null,
    country: country24,
    emptyWeight: null,
    maxTakeoffWeight: null,
    fuelCapacity: null,
    fuelType: null,
    cruiseSpeed: null,
    maxSpeed: null,
    maxRange: null,
    serviceCeiling: null,
    climbRate: null,
    fuelConsumption: null,
    manufacturerHint,
    categoryHint,
  };
}

function extractPrice(text: string): { amount: number | null; negotiable: boolean } {
  const priceMatch =
    text.match(/(?:EUR|€)\s*([\d.,]+)/i) ??
    text.match(/([\d.]+)\s*(?:EUR|€)/i);

  if (priceMatch) {
    let cleaned = priceMatch[1].replace(/\./g, "").replace(",", ".");
    const amount = parseFloat(cleaned);
    return { amount: isNaN(amount) ? null : amount, negotiable: false };
  }

  return { amount: null, negotiable: true };
}
