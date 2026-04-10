/**
 * Localized slug generation matching the TradeAero refactor app pattern.
 * Handles Cyrillic (Russian), Greek, and Turkish transliteration.
 */

const CYRILLIC_MAP: Record<string, string> = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
  "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
  "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
  "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
  "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
};

const GREEK_MAP: Record<string, string> = {
  "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i",
  "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x",
  "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y",
  "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o",
};

const TURKISH_MAP: Record<string, string> = {
  "ı": "i", "ğ": "g", "ü": "u", "ş": "s", "ö": "o", "ç": "c",
  "İ": "i",
};

function transliterate(text: string): string {
  let result = "";
  for (const char of text.toLowerCase()) {
    result +=
      CYRILLIC_MAP[char] ??
      GREEK_MAP[char] ??
      TURKISH_MAP[char] ??
      char;
  }
  return result;
}

export function generateSlug(text: string, listingNumber?: number): string {
  let slug = transliterate(text)
    // Strip diacritics from Latin chars
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Collapse any run of non-alphanumeric characters to a single hyphen
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  // Avoid cutting mid-word: truncate at last hyphen if within last 20 chars.
  // Also strip any trailing hyphen that `slice(0, 80)` may have left behind
  // (the slice boundary can land immediately before a hyphen, leaving a
  // dangling `-` that would concatenate with the `-${listingNumber}` suffix
  // below to produce an illegal `--` in the final slug).
  if (slug.length === 80) {
    const lastHyphen = slug.lastIndexOf("-");
    if (lastHyphen >= 60) {
      slug = slug.slice(0, lastHyphen);
    }
  }
  slug = slug.replace(/-+$/g, "");

  if (listingNumber) {
    slug = `${slug}-${listingNumber}`;
  }

  // Final defensive pass — guarantee no consecutive hyphens and no
  // leading/trailing hyphens survive in the returned slug regardless of
  // how we got here (truncation edge cases, source text quirks, etc.).
  slug = slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "");

  return slug;
}

/**
 * Generate localized slugs for all translated headlines.
 */
export function generateLocalizedSlugs(
  translations: Record<string, { headline: string }>,
  listingNumber?: number
): Record<string, string> {
  const slugs: Record<string, string> = {};
  for (const [lang, { headline }] of Object.entries(translations)) {
    slugs[lang] = generateSlug(headline, listingNumber);
  }
  return slugs;
}
