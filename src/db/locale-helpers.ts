import { generateLocalizedSlugs } from "../utils/slug.js";
import type { TranslationResult } from "../utils/translate.js";

/**
 * The 14 supported locales for TradeAero listings.
 * Source content is German (de); Claude Haiku translates to all 13 others.
 */
export const LANGS = ["en", "de", "fr", "es", "it", "pl", "cs", "sv", "nl", "pt", "ru", "tr", "el", "no"] as const;

/**
 * Build locale-specific headline, description, and slug fields for all 14 languages.
 * Used by both aircraft and parts DB upsert logic.
 *
 * @param headline - Original headline (German)
 * @param description - Original description (German)
 * @param translations - Translation results from Claude Haiku (null on update path)
 * @returns Record with keys like headline_en, description_de, slug_fr, etc.
 */
export function buildLocaleFields(
  headline: string,
  description: string,
  translations: TranslationResult | null
): Record<string, string> {
  const fields: Record<string, string> = {};
  const slugSource: Record<string, { headline: string }> = {};

  for (const lang of LANGS) {
    const t = translations?.[lang];
    const h = t?.headline ?? headline;
    const d = t?.description ?? description;
    fields[`headline_${lang}`] = h;
    fields[`description_${lang}`] = d;
    slugSource[lang] = { headline: h };
  }

  const slugs = generateLocalizedSlugs(slugSource);
  for (const lang of LANGS) {
    fields[`slug_${lang}`] = slugs[lang];
  }

  return fields;
}
