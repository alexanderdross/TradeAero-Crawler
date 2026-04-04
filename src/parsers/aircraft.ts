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

  // Extract location
  const location = extractLocation(text);

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
    engineHours: null,
    cycles: null,
    mtow: specs.mtow,
    rescueSystem: specs.rescue,
    annualInspection: specs.jnp,
    dulvRef: specs.dulv,
    price: priceInfo.amount,
    priceNegotiable: priceInfo.negotiable,
    location,
    city: null,
    airfieldName: null,
    icaoCode: null,
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    imageUrls: images,
    registration: null,
    serialNumber: null,
    airworthy: null,
    avionicsText: null,
    country: null,
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
}


interface ExtractedSpecs {
  year: number | null;
  engine: string | null;
  totalTime: number | null;
  mtow: number | null;
  rescue: string | null;
  jnp: string | null;
  dulv: string | null;
}

function extractSpecs(text: string): ExtractedSpecs {
  const specs: ExtractedSpecs = {
    year: null,
    engine: null,
    totalTime: null,
    mtow: null,
    rescue: null,
    jnp: null,
    dulv: null,
  };

  // Baujahr (year of manufacture)
  const yearMatch = text.match(/Baujahr[:\s]*(\d{4})/i);
  if (yearMatch) specs.year = parseInt(yearMatch[1], 10);

  // Motor (engine)
  const engineMatch = text.match(/Motor[:\s]*([^•\n]+)/i);
  if (engineMatch) specs.engine = cleanText(engineMatch[1]);

  // Betriebsstunden / TT (total time / flight hours)
  const ttMatch =
    text.match(/(?:Betriebsstunden|TT|Flugstunden)[:\s]*([\d.,]+)/i) ??
    text.match(/(\d+)\s*(?:Stunden|Std|h)\b/i);
  if (ttMatch) specs.totalTime = extractNumber(ttMatch[1]);

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

