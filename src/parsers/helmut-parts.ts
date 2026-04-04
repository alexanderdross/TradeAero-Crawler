import * as cheerio from "cheerio";
import {
  cleanText,
  extractNumber,
  generateSourceId,
  parseGermanDate,
} from "../utils/html.js";
import { logger } from "../utils/logger.js";
import type { ParsedPartsListing } from "../types.js";
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
 * Parse parts listings from Helmut's UL Seiten verkauf2.html.
 *
 * The parts page has a similar unstructured layout to aircraft pages but
 * includes category groupings: Avionics, Engines, Rescue Devices, Miscellaneous.
 */
export function parsePartsPage(
  html: string,
  pageUrl: string,
  sourceName: string
): ParsedPartsListing[] {
  const $ = cheerio.load(html);
  const listings: ParsedPartsListing[] = [];

  const body = $("body").html() ?? "";
  const blocks = splitIntoBlocks(body, 30);

  let currentCategory: ParsedPartsListing["category"] = "miscellaneous";

  logger.info(`Found ${blocks.length} potential parts blocks`, { pageUrl });

  for (let i = 0; i < blocks.length; i++) {
    // Check if this block is a category header
    const detectedCategory = detectCategory(blocks[i]);
    if (detectedCategory) {
      currentCategory = detectedCategory;
      continue;
    }

    try {
      const listing = parsePartsBlock(blocks[i], i, pageUrl, sourceName, currentCategory);
      if (listing) {
        listings.push(listing);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse parts block ${i}`, { pageUrl, error: msg });
    }
  }

  logger.info(`Parsed ${listings.length} parts listings`, { pageUrl });
  return listings;
}


/**
 * Detect if a block is a category header and return the category.
 *
 * A header block is short (< 200 chars after stripping tags) and contains
 * no price indicators or dates — those are listing content, not headers.
 */
function detectCategory(blockHtml: string): ParsedPartsListing["category"] | null {
  const text = blockHtml.replace(/<[^>]+>/g, "").trim();
  const lower = text.toLowerCase();

  // Must be short and must NOT look like a listing (no price, no date pattern)
  const looksLikeListing =
    /\d{2}\.\d{2}\.\d{4}/.test(text) ||   // German date dd.mm.yyyy
    /€|eur|\d+[.,]\d{2}/.test(lower) ||    // price
    text.length > 200;

  if (looksLikeListing) return null;

  if (/avionik|navigationsger|transponder|funkger|avionics/i.test(lower)) return "avionics";
  if (/motor(?:en)?(?:\s|\/|$)|triebwerk|engine/i.test(lower)) return "engines";
  if (/propeller|luftschraube/i.test(lower)) return "propellers";
  if (/instrument|anzeige|cockpit/i.test(lower)) return "instruments";
  if (/rettung|rettungsger|rettungssystem|fallschirm/i.test(lower)) return "rescue";
  if (/sonstig|zubehör|diverses|misc/i.test(lower)) return "miscellaneous";

  return null;
}

function parsePartsBlock(
  blockHtml: string,
  index: number,
  pageUrl: string,
  sourceName: string,
  category: ParsedPartsListing["category"]
): ParsedPartsListing | null {
  const $block = cheerio.load(blockHtml);
  const text = cleanText($block("body").text());

  if (isNavigationBlock(text)) return null;

  // Extract date
  const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
  const postedDate = dateMatch ? parseGermanDate(dateMatch[1]) : null;

  // Extract title
  const title = extractTitle($block, text);
  if (!title || title.length < 3) return null;

  // Extract total time / hours
  const ttMatch = text.match(/(?:TTSN|Betriebsstunden|TT|Laufzeit)[:\s]*([\d.,]+)/i);
  const totalTime = ttMatch ? extractNumber(ttMatch[1]) : null;

  // Extract condition
  const conditionMatch = text.match(
    /(?:Zustand|Condition)[:\s]*([^\n•,]+)/i
  );
  const condition = conditionMatch ? cleanText(conditionMatch[1]) : null;

  // Extract price
  const priceInfo = extractPriceFromText(text);

  // Extract VAT status
  const vatIncluded = /MWSt\s*ausweisbar/i.test(text)
    ? true
    : /MWSt\s*nicht\s*ausweisbar/i.test(text)
      ? false
      : null;

  // Extract contact
  const contact = extractContact(blockHtml, text);

  // Extract images
  const images = extractImages($block, pageUrl);

  // Extract location
  const location = extractLocation(text);

  // Build description
  const description = text.length > 200 ? text.slice(0, 2000) : text;

  return {
    sourceId: generateSourceId(pageUrl, index, postedDate ?? undefined),
    sourceUrl: pageUrl,
    sourceName,
    postedDate,
    title,
    description,
    category,
    totalTime,
    condition,
    price: priceInfo.amount,
    priceNegotiable: priceInfo.negotiable,
    vatIncluded,
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    imageUrls: images,
    location,
  };
}

