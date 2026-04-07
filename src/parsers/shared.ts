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
    return stripTitleDatePrefix(cleanText(bold));
  }

  // Try first significant line (after date)
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 3);
  for (const line of lines) {
    // Skip date-only lines
    if (/^\d{1,2}\.\d{2}\.\d{4}$/.test(line)) continue;
    // Skip bullet points
    if (line.startsWith("•")) continue;
    if (line.length < 200) return stripTitleDatePrefix(line);
  }

  return stripTitleDatePrefix(text.slice(0, 100));
}

/**
 * Strip leading date prefix from title text.
 * "17.01.2025 Breezer Sport..." → "Breezer Sport..."
 * "3.04.2025 RANS S-10..." → "RANS S-10..."
 * "Update 22.06.2025 Pioneer 300..." → "Pioneer 300..."
 */
export function stripTitleDatePrefix(title: string): string {
  return title
    .replace(/^(?:update\s+)?\d{1,2}\.\d{2}\.\d{4}\s*/i, "")
    .trim();
}

/**
 * Extract price from listing text.
 * Handles German price formats: EUR 8.900,-, Preis: 15000 VB, etc.
 */
export function extractPriceFromText(text: string): { amount: number | null; negotiable: boolean } {
  // Detect "price negotiable" phrases (German): Preis verhandelbar, Verhandlungsbasis, VB, auf Anfrage
  const isNegotiablePhrase = /(?:Preis\s+)?(?:verhandelbar|Verhandlungsbasis|auf\s+Anfrage|nach\s+Vereinbarung)/i.test(text);

  // Look for price patterns: €12.500, EUR 8.900,-, Preis: 15000 VB
  const priceMatch =
    text.match(/(?:Preis|€|EUR)\s*:?\s*([\d.,]+)\s*(?:€|EUR)?\s*,?-?\s*(VB|VHB|FP)?/i) ??
    text.match(/€\s*([\d.,]+)\s*,?-?\s*(VB|VHB|FP)?/i) ??
    text.match(/([\d.,]{2,})\s*(?:€|EUR)\s*(VB|VHB|FP)?/i);

  if (priceMatch) {
    const result = parsePrice(`€${priceMatch[1]} ${priceMatch[2] ?? ""}`);
    // If the amount parsed as 0, treat as no price
    if (result.amount === 0) {
      return { amount: null, negotiable: isNegotiablePhrase || result.negotiable };
    }
    return { ...result, negotiable: result.negotiable || isNegotiablePhrase };
  }

  // No numeric price found — mark negotiable only if text explicitly says so
  return { amount: null, negotiable: isNegotiablePhrase };
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
    /(?:Kontakt|Ansprechpartner|Verkäufer)[:\s]*([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/i
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
  // Common patterns: "Standort: City", "Raum City", postal code + city
  const structuredMatch =
    text.match(/(?:Standort|Raum|Region|Nähe|stationiert\s+(?:in|bei))[:\s]*([A-ZÄÖÜ][a-zäöüß]+(?:[\s-][A-ZÄÖÜ]?[a-zäöüß]+){0,3})/i);
  if (structuredMatch) {
    return cleanText(structuredMatch[1]);
  }

  // German postal code + city: "86150 Augsburg", "86150 Bad Aibling"
  // Extra words must start with uppercase to avoid capturing lowercase description text
  // Case-insensitive flag handles city names with non-standard casing (e.g. "augsburg", "AUGSBURG")
  const postalMatch = text.match(/(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]+(?:[\s-][A-ZÄÖÜ][a-zäöüß]+){0,2})/i);
  if (postalMatch) {
    return cleanText(`${postalMatch[1]} ${postalMatch[2]}`);
  }

  return null;
}

/**
 * Extract city name from location text.
 * "Standort: Augsburg" → "Augsburg"
 * "86150 Augsburg" → "Augsburg"
 * "Raum Frankfurt" → "Frankfurt"
 * "Nähe München" → "München"
 */
export function extractCity(location: string | null): string | null {
  if (!location) return null;

  // Strip known prefixes to get city name
  let city = location
    .replace(/^(?:Standort|Raum|Region|Nähe)[:\s]*/i, "")
    .replace(/^\d{5}\s*/, "") // Strip postal code
    .trim();

  // Take first word/phrase (stop at slash, dash with spaces, or parentheses)
  city = city.split(/\s*[/()]\s*/)[0].trim();

  // Must be at least 2 chars and start with a letter (case-insensitive to
  // handle city names with non-standard casing)
  if (city.length >= 2 && /^[A-ZÄÖÜa-zäöü]/i.test(city)) {
    return city;
  }

  return null;
}

/**
 * Extract airfield/airport or ICAO code from listing text.
 * Matches patterns like "Flugplatz Strausberg", "EDAZ", "Heimatflugplatz: EDMT"
 */
export function extractAirfield(text: string): { name: string | null; icao: string | null } {
  // ICAO code: 4 uppercase letters with common European prefixes
  // ED=Germany, LO=Austria, LS=Switzerland, EG=UK, LF=France, EB=Belgium,
  // LP=Portugal, LE=Spain, LK=Czech, EP=Poland, EH=Netherlands, LI=Italy,
  // EK=Denmark, ES=Sweden, EN=Norway, EF=Finland
  const icaoMatch = text.match(/\b((?:ED|LO|LS|EG|LF|EB|LP|LE|LK|EP|EH|LI|EK|ES|EN|EF)[A-Z]{2})\b/);
  const icao = icaoMatch ? icaoMatch[1] : null;

  // Airfield name patterns
  const airfieldMatch = text.match(
    /(?:Flugplatz|Flughafen|Heimatflugplatz|Heimatflughafen|Flugfeld|Sonderlandeplatz|Verkehrslandeplatz|Landeplatz|UL-Gelände|UL-Platz|stationiert\s+(?:in|am|auf))[:\s]*([^\n•,]+)/i
  );

  const ICAO_PATTERN = /\b(?:ED|LO|LS|EG|LF|EB|LP|LE|LK|EP|EH|LI|EK|ES|EN|EF)[A-Z]{2}\b/g;
  const name = airfieldMatch ? cleanText(airfieldMatch[1]).replace(ICAO_PATTERN, "").trim() : null;

  return { name: name || null, icao };
}
