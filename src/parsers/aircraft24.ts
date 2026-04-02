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
        const base = new URL(pageUrl).origin;
        nextPageUrl = href.startsWith("http") ? href : `${base}${href.startsWith("/") ? "" : "/"}${href}`;
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
  const title = $("a").first().text().trim() || $("b, strong").first().text().trim() || text.slice(0, 100);
  if (!title || title.length < 3) return null;

  // Extract year: "Bj.: 2018" or "Bj. 2018"
  const yearMatch = text.match(/Bj\.?\s*:?\s*(\d{4})/i);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Extract TTAF: "TTAF: 1234" or "TT: 1234"
  const ttMatch = text.match(/(?:TTAF|TT|TSN)[:\s]*([\d.,]+)/i);
  const totalTime = ttMatch ? parseFloat(ttMatch[1].replace(/\./g, "").replace(",", ".")) : null;

  // Extract price: "EUR 89.000" or "€ 89.000" or "89.000 EUR"
  const priceInfo = extractPrice(text);

  // Extract location: "Standort: München (EDDM)"
  const locationMatch = text.match(/(?:Standort|Location)[:\s]*([^;|\n]+)/i);
  const location = locationMatch ? cleanText(locationMatch[1]) : null;

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
    mtow: null,
    rescueSystem: null,
    annualInspection: null,
    dulvRef: null,
    price: priceInfo.amount,
    priceNegotiable: priceInfo.negotiable,
    location,
    city: null,
    airfieldName: null,
    icaoCode: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    imageUrls: images,
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
