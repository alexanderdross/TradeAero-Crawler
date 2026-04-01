import * as cheerio from "cheerio";
import { cleanText, generateSourceId } from "../utils/html.js";
import { logger } from "../utils/logger.js";
import type { ParsedAircraftListing, ParsedPartsListing } from "../types.js";

/**
 * Parse aircraft listings from aeromarkt.net.
 *
 * Site structure (from homepage observation):
 * - Categories: Kolbenmotorflugzeuge, Jets & Turboprops, Helikopter & Gyrocopter,
 *   Leichtflugzeuge (UL, VLA, ELA), Experimentals & Classics, Sonstige Luftfahrzeuge
 * - Parts: Triebwerke, Avionik & Instrumente
 *
 * TODO: Refine selectors once we can test against live HTML.
 * The site uses a modern layout with category cards and listing pages.
 * Parsers need to be calibrated against actual HTML structure.
 */
export function parseAeromarktAircraftPage(
  html: string,
  pageUrl: string,
  sourceName: string
): { listings: ParsedAircraftListing[]; nextPageUrl: string | null } {
  const $ = cheerio.load(html);
  const listings: ParsedAircraftListing[] = [];

  // Try common listing container patterns
  const selectors = [
    ".listing-item", ".ad-item", ".classified-item",
    ".offer-item", ".result-item", "article.listing",
    ".inserat", ".anzeige", ".angebot",
    "table.results tr", ".search-result",
  ];

  let blocks: string[] = [];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      blocks.push($.html(el));
    });
    if (blocks.length > 0) {
      logger.debug(`Found listings with selector: ${selector}`, { count: blocks.length, pageUrl });
      break;
    }
  }

  // Fallback: look for structured data or repeated patterns
  if (blocks.length === 0) {
    // Try finding links that look like detail pages
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().trim();
      // Aeromarkt detail pages likely have /inserat/, /angebot/, or numeric IDs
      if ((href.includes("/inserat/") || href.includes("/angebot/") || /\/\d{4,}/.test(href)) && text.length > 10) {
        const parent = $(el).closest("div, li, article, tr");
        if (parent.length) {
          blocks.push($.html(parent));
        }
      }
    });
  }

  for (let i = 0; i < blocks.length; i++) {
    try {
      const listing = parseAircraftBlock(blocks[i], i, pageUrl, sourceName);
      if (listing) listings.push(listing);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse aeromarkt block ${i}`, { pageUrl, error: msg });
    }
  }

  // Pagination: look for "next" links
  let nextPageUrl: string | null = null;
  $("a").each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    const rel = $(el).attr("rel") ?? "";
    if (text === "weiter" || text === "»" || text === "next" || rel === "next") {
      const href = $(el).attr("href");
      if (href) {
        const base = new URL(pageUrl).origin;
        nextPageUrl = href.startsWith("http") ? href : `${base}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    }
  });

  logger.info(`Parsed aeromarkt aircraft page`, { pageUrl, listings: listings.length, hasNext: !!nextPageUrl });
  return { listings, nextPageUrl };
}

export function parseAeromarktPartsPage(
  html: string,
  pageUrl: string,
  sourceName: string
): { listings: ParsedPartsListing[]; nextPageUrl: string | null } {
  const $ = cheerio.load(html);
  const listings: ParsedPartsListing[] = [];

  // Similar approach as aircraft — try common selectors
  const selectors = [
    ".listing-item", ".ad-item", ".offer-item", ".result-item",
    ".inserat", ".anzeige", ".angebot",
  ];

  let blocks: string[] = [];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      blocks.push($.html(el));
    });
    if (blocks.length > 0) break;
  }

  for (let i = 0; i < blocks.length; i++) {
    try {
      const listing = parsePartsBlock(blocks[i], i, pageUrl, sourceName);
      if (listing) listings.push(listing);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse aeromarkt parts block ${i}`, { pageUrl, error: msg });
    }
  }

  let nextPageUrl: string | null = null;
  $("a").each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text === "weiter" || text === "»" || text === "next") {
      const href = $(el).attr("href");
      if (href) {
        const base = new URL(pageUrl).origin;
        nextPageUrl = href.startsWith("http") ? href : `${base}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    }
  });

  logger.info(`Parsed aeromarkt parts page`, { pageUrl, listings: listings.length, hasNext: !!nextPageUrl });
  return { listings, nextPageUrl };
}

function parseAircraftBlock(
  blockHtml: string,
  index: number,
  pageUrl: string,
  sourceName: string
): ParsedAircraftListing | null {
  const $ = cheerio.load(blockHtml);
  const text = cleanText($("body").text());
  if (text.length < 15) return null;

  const title = $("a").first().text().trim() || $("h2, h3, h4, .title").first().text().trim() || text.slice(0, 100);
  if (!title || title.length < 3) return null;

  const yearMatch = text.match(/(?:Bj\.?|Baujahr|Year)[:\s]*(\d{4})/i);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  const ttMatch = text.match(/(?:TT|TTAF|Flugstunden|TSN)[:\s]*([\d.,]+)/i);
  const totalTime = ttMatch ? parseFloat(ttMatch[1].replace(/\./g, "").replace(",", ".")) : null;

  const priceMatch = text.match(/(?:€|EUR)\s*([\d.,]+)/i) ?? text.match(/([\d.]+)\s*(?:€|EUR)/i);
  let price: number | null = null;
  if (priceMatch) {
    const cleaned = priceMatch[1].replace(/\./g, "").replace(",", ".");
    price = parseFloat(cleaned);
    if (isNaN(price)) price = null;
  }

  const locationMatch = text.match(/(?:Standort|Location|Ort)[:\s]*([^,\n]+)/i);

  const images: string[] = [];
  const baseUrl = new URL(pageUrl).origin;
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (src && !src.includes("logo") && !src.includes("icon") && !src.includes("banner") && !src.includes("pixel")) {
      images.push(src.startsWith("http") ? src : `${baseUrl}${src.startsWith("/") ? "" : "/"}${src}`);
    }
  });

  return {
    sourceId: generateSourceId(pageUrl, index),
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
    price,
    priceNegotiable: price === null,
    location: locationMatch ? cleanText(locationMatch[1]) : null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    imageUrls: images,
  };
}

function parsePartsBlock(
  blockHtml: string,
  index: number,
  pageUrl: string,
  sourceName: string
): ParsedPartsListing | null {
  const $ = cheerio.load(blockHtml);
  const text = cleanText($("body").text());
  if (text.length < 15) return null;

  const title = $("a").first().text().trim() || $("h2, h3, h4").first().text().trim() || text.slice(0, 100);
  if (!title || title.length < 3) return null;

  const priceMatch = text.match(/(?:€|EUR)\s*([\d.,]+)/i);
  let price: number | null = null;
  if (priceMatch) {
    const cleaned = priceMatch[1].replace(/\./g, "").replace(",", ".");
    price = parseFloat(cleaned);
    if (isNaN(price)) price = null;
  }

  // Categorize based on URL or keywords
  let category: "avionics" | "engines" | "rescue" | "miscellaneous" = "miscellaneous";
  if (pageUrl.includes("avionik") || pageUrl.includes("instrumente")) category = "avionics";
  else if (pageUrl.includes("triebwerk")) category = "engines";

  const images: string[] = [];
  const baseUrl = new URL(pageUrl).origin;
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (src && !src.includes("logo") && !src.includes("icon")) {
      images.push(src.startsWith("http") ? src : `${baseUrl}${src.startsWith("/") ? "" : "/"}${src}`);
    }
  });

  return {
    sourceId: generateSourceId(pageUrl, index),
    sourceUrl: pageUrl,
    sourceName,
    postedDate: null,
    title,
    description: text,
    category,
    totalTime: null,
    condition: null,
    price,
    priceNegotiable: price === null,
    vatIncluded: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    imageUrls: images,
    location: null,
  };
}
