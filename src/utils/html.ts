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
  const fixedPrice = /\bFP\b/i.test(raw);

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
    negotiable: negotiable || !fixedPrice,
  };
}

/**
 * Parse a German date string (DD.MM.YYYY) into an ISO date string.
 */
export function parseGermanDate(dateStr: string): string | null {
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
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
 * Clean HTML text: collapse whitespace, trim, decode entities.
 */
export function cleanText(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
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
