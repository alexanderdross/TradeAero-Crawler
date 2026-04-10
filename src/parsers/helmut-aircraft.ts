import * as cheerio from "cheerio";
import {
  cleanText,
  extractNumber,
  generateSourceId,
  parseGermanDate,
} from "../utils/html.js";
import { logger } from "../utils/logger.js";
import type { ParsedAircraftListing } from "../types.js";
import {
  splitIntoBlocks,
  isNavigationBlock,
  extractTitle,
  extractPriceFromText,
  extractContact,
  extractImages,
  extractLocation,
  extractCity,
  extractAirfield,
} from "./shared.js";

/**
 * Parse aircraft listings from a Helmut's UL Seiten page.
 *
 * The pages have NO structured markup (no classes/IDs). Listings are separated
 * by <hr> tags or "* * *" ASCII separators. Each listing block contains:
 *   - Date (DD.MM.YYYY)
 *   - Title / aircraft model
 *   - Bullet-point specs (Baujahr, Motor, Betriebsstunden, MTOW, etc.)
 *   - Description text
 *   - Contact info (obfuscated email, phone)
 *   - Images
 *   - Price (€ with VB/FP suffix)
 *
 * Strategy: Split the HTML into blocks using <hr> delimiters, then parse
 * each block with regex patterns for German aviation terminology.
 */
export function parseAircraftPage(
  html: string,
  pageUrl: string,
  sourceName: string
): ParsedAircraftListing[] {
  const $ = cheerio.load(html);
  const listings: ParsedAircraftListing[] = [];

  // Get the body content and split by <hr> tags
  const body = $("body").html() ?? "";
  const blocks = splitIntoBlocks(body);

  logger.info(`Found ${blocks.length} potential listing blocks`, { pageUrl });

  for (let i = 0; i < blocks.length; i++) {
    try {
      const listing = parseBlock(blocks[i], i, pageUrl, sourceName, $);
      if (listing) {
        listings.push(listing);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse block ${i}`, { pageUrl, error: msg });
    }
  }

  logger.info(`Parsed ${listings.length} aircraft listings`, { pageUrl });
  return listings;
}


/**
 * Parse a single listing block into a ParsedAircraftListing.
 * Returns null if the block doesn't look like a valid listing.
 */
function parseBlock(
  blockHtml: string,
  index: number,
  pageUrl: string,
  sourceName: string,
  _$: cheerio.CheerioAPI
): ParsedAircraftListing | null {
  const $block = cheerio.load(blockHtml);
  const text = cleanText($block("body").text());

  // Skip navigation, headers, and non-listing content
  if (isNavigationBlock(text)) return null;

  // Extract date
  const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
  const postedDate = dateMatch ? parseGermanDate(dateMatch[1]) : null;

  // Extract title: typically the first bold text or first significant line
  const title = extractTitle($block, text);
  if (!title || title.length < 3) return null;

  // Extract specs from bullet points
  const specs = extractSpecs(text);

  // Extract price
  const priceInfo = extractPriceFromText(text);

  // Extract contact info
  const contact = extractContact(blockHtml, text);

  // Extract images
  const images = extractImages($block, pageUrl);

  // Extract description (everything that isn't specs, contact, or price)
  const description = extractDescription(text, title, specs);

  // Extract location, city, and airfield
  const location = extractLocation(text);
  const city = extractCity(location);
  const airfield = extractAirfield(text);

  return {
    sourceId: generateSourceId(pageUrl, index, postedDate ?? undefined),
    sourceUrl: pageUrl,
    sourceName,
    postedDate,
    title,
    description,
    year: specs.year,
    engine: specs.engine,
    totalTime: specs.totalTime,
    engineHours: specs.engineHours,
    cycles: specs.cycles,
    mtow: specs.mtow,
    rescueSystem: specs.rescue,
    annualInspection: specs.jnp,
    dulvRef: specs.dulv,
    price: priceInfo.amount,
    priceNegotiable: priceInfo.negotiable,
    location,
    city,
    airfieldName: airfield.name,
    icaoCode: airfield.icao,
    registration: specs.registration,
    serialNumber: specs.serialNumber,
    airworthy: specs.airworthy,
    avionicsText: specs.avionicsText,
    country: null,
    emptyWeight: specs.emptyWeight,
    maxTakeoffWeight: specs.maxTakeoffWeight,
    fuelCapacity: specs.fuelCapacity,
    fuelType: specs.fuelType,
    cruiseSpeed: specs.cruiseSpeed,
    maxSpeed: specs.maxSpeed,
    maxRange: specs.maxRange,
    serviceCeiling: specs.serviceCeiling,
    climbRate: specs.climbRate,
    fuelConsumption: specs.fuelConsumption,
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    imageUrls: images,
  };
}


interface ExtractedSpecs {
  year: number | null;
  engine: string | null;
  totalTime: number | null;
  engineHours: number | null;
  cycles: number | null;
  mtow: number | null;
  rescue: string | null;
  jnp: string | null;
  dulv: string | null;
  registration: string | null;
  serialNumber: string | null;
  airworthy: boolean | null;
  avionicsText: string | null;
  emptyWeight: number | null;
  maxTakeoffWeight: number | null;
  fuelCapacity: number | null;
  fuelType: string | null;
  cruiseSpeed: number | null;
  maxSpeed: number | null;
  maxRange: number | null;
  serviceCeiling: number | null;
  climbRate: number | null;
  fuelConsumption: number | null;
}

function extractSpecs(text: string): ExtractedSpecs {
  const specs: ExtractedSpecs = {
    year: null,
    engine: null,
    totalTime: null,
    engineHours: null,
    cycles: null,
    mtow: null,
    rescue: null,
    jnp: null,
    dulv: null,
    registration: null,
    serialNumber: null,
    airworthy: null,
    avionicsText: null,
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
  };

  // Baujahr (year of manufacture)
  const yearMatch = text.match(/Baujahr[:\s]*(\d{4})/i);
  if (yearMatch) specs.year = parseInt(yearMatch[1], 10);

  // Motor (engine) — require "Motor:" label (colon mandatory) to avoid matching
  // compound German words like "Kolbenmotorflugzeuge" that contain "motor" but are not engine labels.
  const engineMatch = text.match(/\bMotor\s*:\s*([^•\n]{3,80})/i);
  if (engineMatch) {
    let eng = cleanText(engineMatch[1]);
    // Truncate at tokens that signal the engine field has overflowed into description text
    eng = eng.replace(/\s*(?:Motorstunden|Motorbetriebsstunden|Motor-Std|Motor-BZ|TTSN|TTAF|Zelle|Ausstattung|Baujahr|\bTT\b|\b\d{3,}\s*h\b).*/i, "").trim();
    // Also stop at a dash that introduces avionics ("- Funk", "- Transponder", etc.)
    eng = eng.replace(/\s+-\s+(?:Funk|Transponder|Flarm|FLARM|GPS|MGL|Garmin|ADS|VHF|UKW|Stratos|ELT|Avionik).*/i, "").trim();
    if (eng.length >= 3) specs.engine = eng;
  }

  // Betriebsstunden / TT (total airframe time / TTAF)
  const ttMatch =
    text.match(/(?:Betriebsstunden|TT(?:AF)?|Flugstunden)[:\s]*([\d.,]+)/i) ??
    text.match(/(\d+)\s*(?:Stunden|Std|h)\b/i);
  if (ttMatch) specs.totalTime = extractNumber(ttMatch[1]);

  // Motorstunden / TTSN (engine hours — separate from airframe time)
  const engineHoursMatch = text.match(/(?:Motorstunden|TTSN|Motorbetriebsstunden|Motor-Std|Motor-BZ)[:\s]*([\d.,]+)/i);
  if (engineHoursMatch) specs.engineHours = extractNumber(engineHoursMatch[1]);

  // Landungen / Starts / Zyklen (landings / cycles)
  const cyclesMatch = text.match(/(?:Landungen|Starts|Zyklen|LDG|Ldg\.?)[:\s]*([\d.,]+)/i);
  if (cyclesMatch) specs.cycles = extractNumber(cyclesMatch[1]);

  // MTOW
  const mtowMatch = text.match(/MTOW[:\s]*([\d.,]+)\s*kg/i);
  if (mtowMatch) specs.mtow = extractNumber(mtowMatch[1]);

  // Rettung (rescue/parachute system)
  const rescueMatch = text.match(/Rettung[:\s]*([^•\n]+)/i);
  if (rescueMatch) specs.rescue = cleanText(rescueMatch[1]);

  // JNP (Jahresnachprüfung - annual inspection)
  const jnpMatch = text.match(/(?:JNP|Jahresnachprüfung)[:\s]*(\d{2}\.\d{2}\.\d{4}|\d{2}\/\d{4}|\w+\s+\d{4})/i);
  if (jnpMatch) {
    specs.jnp = parseGermanDate(jnpMatch[1]) ?? jnpMatch[1];
  }

  // DULV Kennblatt
  const dulvMatch = text.match(/DULV[- ]?Kennblatt[:\s]*([^\n•]+)/i);
  if (dulvMatch) specs.dulv = cleanText(dulvMatch[1]);

  // Registration / Kennzeichen
  //
  // Prefer a labeled match ("Kennzeichen: D-MABC") over a free-text match
  // so unrelated tokens that look like a registration (e.g. "ISO-9001",
  // "DULV-4567", "PMA-12345") don't get picked up as the aircraft
  // registration. The free-text fallback is restricted to known aircraft
  // registration prefixes (D, OE, HB, G, F, I, N, SP, OY, OK, SE, LN, PH,
  // etc.) to avoid catching certification codes and part numbers.
  const regKennMatch = text.match(/(?:Kennzeichen|Kennz\.?|Zulassung|Registration)[:\s]*([A-Z]{1,2}-[A-Z0-9]{2,5})/i);
  if (regKennMatch) {
    specs.registration = regKennMatch[1].toUpperCase();
  } else {
    // Free-text fallback: only match tokens that start with a known
    // ICAO national prefix to avoid "ISO-9001" / "DULV-4567" false positives.
    const regFreeMatch = text.match(
      /\b(D-[A-Z0-9]{3,4}|OE-[A-Z]{3}|HB-[A-Z]{3}|G-[A-Z]{4}|F-[A-Z]{4}|I-[A-Z]{4}|N[0-9]{1,5}[A-Z]{0,2}|SP-[A-Z]{3}|OY-[A-Z]{3}|OK-[A-Z]{3}|SE-[A-Z]{3}|LN-[A-Z]{3}|PH-[A-Z]{3})\b/,
    );
    if (regFreeMatch) specs.registration = regFreeMatch[1].toUpperCase();
  }

  // Serial number / Werk-Nr.
  const serialMatch = text.match(/(?:Werk[- ]?Nr\.?|S\/N|Seriennummer|Serial)[:\s]*([A-Z0-9][\w-]{1,20})/i);
  if (serialMatch) specs.serialNumber = serialMatch[1].trim();

  // Airworthiness
  if (/nicht\s*(?:luft|verkehrs)tüchtig|not\s+airworthy/i.test(text)) {
    specs.airworthy = false;
  } else if (/(?:luft|verkehrs)tüchtig(?!\s*zeugnis)|LTB\s+vorhanden|airworthy/i.test(text)) {
    specs.airworthy = true;
  }

  // Avionics free-text: collect lines that mention avionics equipment
  const AVIONICS_KEYWORDS = ['GPS', 'Transponder', 'Funke', 'VOR', 'ILS', 'ADS-B', 'FLARM',
    'Autopilot', 'Garmin', 'Dynon', 'Becker', 'Trig', 'Bendix', 'King',
    'SkyDemon', 'SkyView', 'XPNDR', 'Mode-S', 'Mode-C', 'TCAS'];
  const avLines: string[] = [];
  for (const segment of text.split(/[•\n]/)) {
    const seg = segment.trim();
    if (seg.length > 2 && seg.length < 200 && AVIONICS_KEYWORDS.some(k => seg.includes(k))) {
      avLines.push(seg);
    }
  }
  if (avLines.length > 0) specs.avionicsText = avLines.join('; ');

  // Empty weight / Leergewicht / Leermasse
  const ewMatch = text.match(/(?:Leergewicht|Leermasse|Leer(?:gewicht)?)[:\s]*([\d.,]+)\s*kg/i);
  if (ewMatch) specs.emptyWeight = extractNumber(ewMatch[1]);

  // Max takeoff weight (alternative to MTOW keyword)
  const mtowAltMatch = text.match(/(?:MTOW|Abflugmasse|Abfluggewicht|max\.?\s*Abfluggewicht|MAUW)[:\s]*([\d.,]+)\s*kg/i);
  if (mtowAltMatch) specs.maxTakeoffWeight = extractNumber(mtowAltMatch[1]);

  // Fuel capacity / Tankinhalt
  const fuelCapMatch = text.match(/(?:Tankinhalt|Kraftstoffmenge|Tankvolumen|Tank)[:\s]*([\d.,]+)\s*[lL]/i);
  if (fuelCapMatch) specs.fuelCapacity = extractNumber(fuelCapMatch[1]);

  // Fuel type
  if (/MOGAS|Normalbenzin|Super(?!flug)/i.test(text)) specs.fuelType = "MOGAS";
  else if (/AVGAS|100LL|Aviation\s*Gasoline/i.test(text)) specs.fuelType = "AVGAS";
  else if (/Jet.?A|Kerosin|Diesel|JET/i.test(text)) specs.fuelType = "Jet-A";

  // Cruise speed / Reisegeschwindigkeit
  const cruiseMatch = text.match(/(?:Reisegeschwindigkeit|Reise(?:geschw\.?)?|Vcr|Vc)[:\s]*([\d.,]+)\s*(?:km\/h|kts?|mph)/i);
  if (cruiseMatch) specs.cruiseSpeed = extractNumber(cruiseMatch[1]);

  // Max speed / Höchstgeschwindigkeit / Vne
  const maxSpdMatch = text.match(/(?:Höchstgeschwindigkeit|Vne|Vmax|max\.?\s*Geschwindigkeit)[:\s]*([\d.,]+)\s*(?:km\/h|kts?|mph)/i);
  if (maxSpdMatch) specs.maxSpeed = extractNumber(maxSpdMatch[1]);

  // Range / Reichweite
  const rangeMatch = text.match(/(?:Reichweite|Aktionsradius|Range)[:\s]*([\d.,]+)\s*(?:km|nm|mi)/i);
  if (rangeMatch) specs.maxRange = extractNumber(rangeMatch[1]);

  // Service ceiling / Gipfelhöhe / Dienstgipfelhöhe
  const ceilMatch = text.match(/(?:Gipfelhöhe|Dienstgipfelhöhe|Betriebshöhe|Service\s*Ceiling)[:\s]*([\d.,]+)\s*(?:m|ft)/i);
  if (ceilMatch) specs.serviceCeiling = extractNumber(ceilMatch[1]);

  // Climb rate / Steigleistung
  const climbMatch = text.match(/(?:Steigleistung|Steigrate|Climb\s*Rate)[:\s]*([\d.,]+)\s*(?:m\/s|ft\/min|fpm)/i);
  if (climbMatch) specs.climbRate = extractNumber(climbMatch[1]);

  // Fuel consumption / Verbrauch
  const consumptionMatch = text.match(/(?:Verbrauch|Kraftstoffverbrauch|Consumption)[:\s]*([\d.,]+)\s*(?:L\/h|l\/h|ltr\/h|gal\/h)/i);
  if (consumptionMatch) specs.fuelConsumption = extractNumber(consumptionMatch[1]);

  return specs;
}


function extractDescription(
  text: string,
  title: string,
  _specs: ExtractedSpecs
): string {
  // Remove the title, specs, and price from the text to get pure description
  let desc = text;

  // Remove known spec patterns
  const patternsToRemove = [
    /Baujahr[:\s]*\d{4}/gi,
    /Motor[:\s]*[^•\n]+/gi,
    /(?:Betriebsstunden|TT|Flugstunden)[:\s]*[\d.,]+/gi,
    /MTOW[:\s]*[\d.,]+\s*kg/gi,
    /Rettung[:\s]*[^•\n]+/gi,
    /(?:JNP|Jahresnachprüfung)[:\s]*[^\n•]+/gi,
    /DULV[- ]?Kennblatt[:\s]*[^\n•]+/gi,
    /€[\d.,]+\s*,?-?\s*(?:VB|VHB|FP)?/gi,
    /(?:Tel\.?|Telefon|Mobil)[:\s]*[\d\s/+()-]+/gi,
  ];

  for (const pattern of patternsToRemove) {
    desc = desc.replace(pattern, "");
  }

  // Remove title from beginning
  if (desc.startsWith(title)) {
    desc = desc.slice(title.length);
  }

  // Clean up bullet points and extra whitespace
  desc = desc.replace(/•/g, "").replace(/\s+/g, " ").trim();

  return desc || title;
}

