import * as cheerio from "cheerio";
import { cleanText, decodeEmail, parsePrice } from "../utils/html.js";

/**
 * Shared parsing functions used by both aircraft and parts Helmut parsers.
 *
 * These were extracted from helmut-aircraft.ts and helmut-parts.ts (and their
 * legacy aliases aircraft.ts and parts.ts) to eliminate duplication.
 */

/**
 * Split page HTML into listing blocks using <hr> or "* * *" separators.
 * Filters out blocks that are too short to be real listings.
 *
 * @param html - Raw HTML body content
 * @param minLength - Minimum text length for a block to be considered valid (default 50)
 */
export function splitIntoBlocks(html: string, minLength = 50): string[] {
  // Split on <hr> tags (various formats) or "* * *" separators
  const blocks = html.split(/<hr\s*\/?>/gi);

  // Further split on "* * *" if present within blocks
  const allBlocks: string[] = [];
  for (const block of blocks) {
    const subBlocks = block.split(/\*\s*\*\s*\*/);
    allBlocks.push(...subBlocks);
  }

  // Filter: must have meaningful content
  return allBlocks.filter((block) => {
    const textOnly = block.replace(/<[^>]+>/g, "").trim();
    return textOnly.length > minLength;
  });
}

/**
 * Check if a block is navigation/header content that should be skipped.
 */
export function isNavigationBlock(text: string): boolean {
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

/**
 * Extract listing title from a parsed block.
 * Tries bold text first, then falls back to the first significant line.
 */
export function extractTitle($block: cheerio.CheerioAPI, text: string): string {
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

/**
 * Extract price from listing text.
 * Handles German price formats: EUR 8.900,-, Preis: 15000 VB, etc.
 */
export function extractPriceFromText(text: string): { amount: number | null; negotiable: boolean } {
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

/**
 * Extract contact information (name, email, phone) from listing HTML/text.
 */
export function extractContact(
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

/**
 * Extract image URLs from a parsed block, resolving relative URLs.
 * Skips tiny icons (< 50px) and non-image URLs.
 */
export function extractImages($block: cheerio.CheerioAPI, pageUrl: string): string[] {
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

/**
 * Extract location from listing text.
 * Looks for patterns like "Standort: ...", "Raum ...", or German postal codes.
 */
export function extractLocation(text: string): string | null {
  // Common patterns: "Standort: ...", "Raum ...", "PLZ ...", city names
  const locationMatch =
    text.match(/(?:Standort|Raum|Region|Nähe)[:\s]*([^\n•,]+)/i) ??
    text.match(/(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]+)/); // German postal code + city

  if (locationMatch) {
    return cleanText(locationMatch[0]);
  }

  return null;
}
