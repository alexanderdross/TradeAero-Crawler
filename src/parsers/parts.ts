import * as cheerio from "cheerio";
import {
  cleanText,
  decodeEmail,
  extractNumber,
  generateSourceId,
  parseGermanDate,
  parsePrice,
} from "../utils/html.js";
import { logger } from "../utils/logger.js";
import type { ParsedPartsListing } from "../types.js";

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
  const blocks = splitIntoBlocks(body);

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

function splitIntoBlocks(html: string): string[] {
  const blocks = html.split(/<hr\s*\/?>/gi);
  const allBlocks: string[] = [];
  for (const block of blocks) {
    const subBlocks = block.split(/\*\s*\*\s*\*/);
    allBlocks.push(...subBlocks);
  }
  return allBlocks.filter((block) => {
    const textOnly = block.replace(/<[^>]+>/g, "").trim();
    return textOnly.length > 30;
  });
}

/**
 * Detect if a block is a category header and return the category.
 */
function detectCategory(blockHtml: string): ParsedPartsListing["category"] | null {
  const text = blockHtml.replace(/<[^>]+>/g, "").trim().toLowerCase();

  if (/avionik|navigationsger|transponder|funkger/i.test(text) && text.length < 100) {
    return "avionics";
  }
  if (/motor(?:en)?(?:\s|$)|triebwerk/i.test(text) && text.length < 100) {
    return "engines";
  }
  if (/rettung|rettungsger|rettungssystem/i.test(text) && text.length < 100) {
    return "rescue";
  }
  if (/sonstig|zubehör|diverses/i.test(text) && text.length < 100) {
    return "miscellaneous";
  }

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

function isNavigationBlock(text: string): boolean {
  if (text.length > 200) return false;
  const navKeywords = ["Startseite", "Navigation", "Impressum", "HOME", "Cookie"];
  const lower = text.toLowerCase();
  return navKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function extractTitle($block: cheerio.CheerioAPI, text: string): string {
  const bold = $block("b, strong").first().text().trim();
  if (bold && bold.length > 3 && bold.length < 200) {
    return cleanText(bold);
  }
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 3);
  for (const line of lines) {
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(line)) continue;
    if (line.startsWith("•")) continue;
    if (line.length < 200) return line;
  }
  return text.slice(0, 100);
}

function extractPriceFromText(text: string): { amount: number | null; negotiable: boolean } {
  const priceMatch =
    text.match(/(?:Preis|€|EUR)\s*:?\s*([\d.,]+)\s*(?:€|EUR)?\s*,?-?\s*(VB|VHB|FP)?/i) ??
    text.match(/€\s*([\d.,]+)\s*,?-?\s*(VB|VHB|FP)?/i) ??
    text.match(/([\d.]+)\s*(?:€|EUR)\s*(VB|VHB|FP)?/i);

  if (priceMatch) {
    return parsePrice(`€${priceMatch[1]} ${priceMatch[2] ?? ""}`);
  }
  return { amount: null, negotiable: true };
}

function extractContact(
  html: string,
  text: string
): { name: string | null; email: string | null; phone: string | null } {
  let email: string | null = null;
  const mailtoMatch = html.match(/mailto:([^"'\s]+)/i);
  if (mailtoMatch) {
    email = decodeEmail(mailtoMatch[1]);
  } else {
    const atMatch = text.match(/[\w.-]+\s*\[at\]\s*[\w.-]+\.\w+/i);
    if (atMatch) email = decodeEmail(atMatch[0]);
  }

  let phone: string | null = null;
  const phoneMatch = text.match(
    /(?:Tel\.?|Telefon|Mobil|Handy|Phone)[:\s]*([\d\s/+()-]{7,20})/i
  );
  if (phoneMatch) phone = phoneMatch[1].trim();

  let name: string | null = null;
  const nameMatch = text.match(
    /(?:Kontakt|Ansprechpartner|Verkäufer)[:\s]*([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/
  );
  if (nameMatch) name = nameMatch[1];

  return { name, email, phone };
}

function extractImages($block: cheerio.CheerioAPI, pageUrl: string): string[] {
  const images: string[] = [];
  const baseUrl = new URL(pageUrl).origin;

  $block("img").each((_, el) => {
    const src = $block(el).attr("src");
    if (!src) return;
    const width = parseInt($block(el).attr("width") ?? "999", 10);
    const height = parseInt($block(el).attr("height") ?? "999", 10);
    if (width < 50 || height < 50) return;

    let absoluteUrl: string;
    if (src.startsWith("http")) {
      absoluteUrl = src;
    } else if (src.startsWith("/")) {
      absoluteUrl = `${baseUrl}${src}`;
    } else {
      const pagePath = pageUrl.substring(0, pageUrl.lastIndexOf("/") + 1);
      absoluteUrl = `${pagePath}${src}`;
    }

    if (/\.(jpg|jpeg|png|gif|webp)/i.test(absoluteUrl)) {
      images.push(absoluteUrl);
    }
  });

  return images;
}

function extractLocation(text: string): string | null {
  const locationMatch =
    text.match(/(?:Standort|Raum|Region|Nähe)[:\s]*([^\n•,]+)/i) ??
    text.match(/(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]+)/);
  return locationMatch ? cleanText(locationMatch[0]) : null;
}
