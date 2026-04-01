/**
 * HTML utility functions for scraping Helmut's UL Seiten.
 * Handles email deobfuscation, price parsing, and German text normalization.
 */

/**
 * Decode hex-encoded email addresses used on Helmut's pages.
 * Converts patterns like `%66ly2dr%69me` back to plain text
 * and replaces `[at]` / `(at)` with `@`.
 */
export function decodeEmail(raw: string): string {
  // First decode percent-encoded hex sequences
  let decoded = raw.replace(/%([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Replace common obfuscation patterns
  decoded = decoded.replace(/\s*\[at\]\s*/gi, "@");
  decoded = decoded.replace(/\s*\(at\)\s*/gi, "@");
  decoded = decoded.replace(/\s*\[dot\]\s*/gi, ".");
  decoded = decoded.replace(/\s*\(dot\)\s*/gi, ".");
  return decoded.trim();
}

/**
 * Parse a German-formatted price string into a numeric value.
 * Handles formats like: "€12.500,-", "12500", "12.500 VB", "€ 8.900,-"
 * Returns null if price cannot be parsed.
 */
export function parsePrice(raw: string): { amount: number | null; negotiable: boolean } {
  const negotiable = /\bVB\b|\bVHB\b/i.test(raw);

  // Remove currency symbol, whitespace, and suffix markers
  let cleaned = raw
    .replace(/€/g, "")
    .replace(/\b(VB|VHB|FP)\b/gi, "")
    .replace(/,-/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (!cleaned) return { amount: null, negotiable };

  // German number format: 12.500 (dot as thousands separator)
  // Check if it matches German format (dots as thousands separators, optional comma for decimals)
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }

  const amount = parseFloat(cleaned);
  return {
    amount: isNaN(amount) ? null : amount,
    negotiable,
  };
}

/**
 * Parse a German date string into an ISO date string (YYYY-MM-DD).
 * Handles formats: DD.MM.YYYY, MM/YYYY, "April 2026", "Dez 2025"
 */
export function parseGermanDate(dateStr: string): string | null {
  // DD.MM.YYYY
  const fullMatch = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (fullMatch) {
    const [, day, month, year] = fullMatch;
    return `${year}-${month}-${day}`;
  }

  // MM/YYYY → first of month
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, "0");
    return `${slashMatch[2]}-${month}-01`;
  }

  // German month name + year (e.g., "April 2026", "Dez 2025")
  const germanMonths: Record<string, string> = {
    januar: "01", jan: "01", februar: "02", feb: "02", "märz": "03", mar: "03",
    april: "04", apr: "04", mai: "05", juni: "06", jun: "06",
    juli: "07", jul: "07", august: "08", aug: "08", september: "09", sep: "09",
    oktober: "10", okt: "10", november: "11", nov: "11", dezember: "12", dez: "12",
  };
  const nameMatch = dateStr.match(/([A-Za-zäöü]+)\s+(\d{4})/);
  if (nameMatch) {
    const monthNum = germanMonths[nameMatch[1].toLowerCase()];
    if (monthNum) return `${nameMatch[2]}-${monthNum}-01`;
  }

  return null;
}

/**
 * Extract a numeric value from German text containing numbers.
 * Handles both integer and decimal formats.
 */
export function extractNumber(text: string): number | null {
  // Try German decimal format first (e.g., "1.234,5")
  const germanMatch = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)/);
  if (germanMatch) {
    const cleaned = germanMatch[1].replace(/\./g, "").replace(",", ".");
    const num = parseFloat(cleaned);
    if (!isNaN(num)) return num;
  }
  // Fallback: any number
  const simpleMatch = text.match(/([\d.]+)/);
  if (simpleMatch) {
    const num = parseFloat(simpleMatch[1]);
    if (!isNaN(num)) return num;
  }
  return null;
}

/**
 * Clean HTML text: strip tags, decode entities, collapse whitespace.
 * SECURITY: Strips HTML tags to prevent stored XSS (CWE-79).
 */
export function cleanText(text: string): string {
  return text
    // Strip HTML tags first (prevent stored XSS)
    .replace(/<[^>]*>/g, " ")
    // Decode HTML entities to readable characters
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sanitize text for safe database storage.
 * Strips any remaining HTML tags and script-like content.
 * Used on all text before DB insertion.
 */
export function sanitizeForDb(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "")
    .trim();
}

/**
 * Generate a stable fingerprint for deduplication based on source URL + listing content.
 * Uses a combination of the page URL and extracted listing position/date.
 */
export function generateSourceId(pageUrl: string, listingIndex: number, dateStr?: string): string {
  const base = `${pageUrl}#${listingIndex}`;
  return dateStr ? `${base}@${dateStr}` : base;
}
