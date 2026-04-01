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
import type { ParsedAircraftListing } from "../types.js";

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
 * Split page HTML into listing blocks using <hr> or "* * *" separators.
 * Filters out blocks that are too short to be real listings.
 */
function splitIntoBlocks(html: string): string[] {
  // Split on <hr> tags (various formats) or "* * *" separators
  const blocks = html.split(/<hr\s*\/?>/gi);

  // Further split on "* * *" if present within blocks
  const allBlocks: string[] = [];
  for (const block of blocks) {
    const subBlocks = block.split(/\*\s*\*\s*\*/);
    allBlocks.push(...subBlocks);
  }

  // Filter: must have meaningful content (at least 50 chars of text)
  return allBlocks.filter((block) => {
    const textOnly = block.replace(/<[^>]+>/g, "").trim();
    return textOnly.length > 50;
  });
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
    mtow: specs.mtow,
    rescueSystem: specs.rescue,
    annualInspection: specs.jnp,
    dulvRef: specs.dulv,
    price: priceInfo.amount,
    priceNegotiable: priceInfo.negotiable,
    location,
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    imageUrls: images,
  };
}

function isNavigationBlock(text: string): boolean {
  const navKeywords = [
    "Startseite",
    "Navigation",
    "Impressum",
    "Datenschutz",
    "Cookie",
    "Seitennavigation",
    "HOME",
  ];
  const lower = text.toLowerCase();
  // If block is short and contains nav keywords, skip
  if (text.length < 200) {
    return navKeywords.some((kw) => lower.includes(kw.toLowerCase()));
  }
  return false;
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

function extractTitle($block: cheerio.CheerioAPI, text: string): string {
  // Try bold text first
  const bold = $block("b, strong").first().text().trim();
  if (bold && bold.length > 3 && bold.length < 200) {
    return cleanText(bold);
  }

  // Try first significant line (after date)
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 3);
  for (const line of lines) {
    // Skip date-only lines
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(line)) continue;
    // Skip bullet points
    if (line.startsWith("•")) continue;
    if (line.length < 200) return line;
  }

  return text.slice(0, 100);
}

function extractPriceFromText(text: string): { amount: number | null; negotiable: boolean } {
  // Look for price patterns: €12.500, EUR 8.900,-, Preis: 15000 VB
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
  // Email: look for mailto: links or [at] patterns
  let email: string | null = null;
  const mailtoMatch = html.match(/mailto:([^"'\s]+)/i);
  if (mailtoMatch) {
    email = decodeEmail(mailtoMatch[1]);
  } else {
    const atMatch = text.match(/[\w.-]+\s*\[at\]\s*[\w.-]+\.\w+/i);
    if (atMatch) email = decodeEmail(atMatch[0]);
  }

  // Phone: look for common German phone patterns
  let phone: string | null = null;
  const phoneMatch = text.match(
    /(?:Tel\.?|Telefon|Mobil|Handy|Phone)[:\s]*([\d\s/+()-]{7,20})/i
  );
  if (phoneMatch) phone = phoneMatch[1].trim();

  // Name: try to find before contact details
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

    // Skip tiny icons and navigation images
    const width = parseInt($block(el).attr("width") ?? "999", 10);
    const height = parseInt($block(el).attr("height") ?? "999", 10);
    if (width < 50 || height < 50) return;

    // Build absolute URL
    let absoluteUrl: string;
    if (src.startsWith("http")) {
      absoluteUrl = src;
    } else if (src.startsWith("/")) {
      absoluteUrl = `${baseUrl}${src}`;
    } else {
      // Relative path - resolve against page URL
      const pagePath = pageUrl.substring(0, pageUrl.lastIndexOf("/") + 1);
      absoluteUrl = `${pagePath}${src}`;
    }

    // Only include image-like URLs
    if (/\.(jpg|jpeg|png|gif|webp)/i.test(absoluteUrl)) {
      images.push(absoluteUrl);
    }
  });

  return images;
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

function extractLocation(text: string): string | null {
  // Common patterns: "Standort: ...", "Raum ...", "PLZ ...", city names
  const locationMatch =
    text.match(/(?:Standort|Raum|Region|Nähe)[:\s]*([^\n•,]+)/i) ??
    text.match(/(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]+)/); // German postal code + city

  if (locationMatch) {
    return cleanText(locationMatch[0]);
  }

  return null;
}
