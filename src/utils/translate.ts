import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";

const TARGET_LANGS = [
  "en", "de", "fr", "es", "it", "pl", "cs", "sv", "nl", "pt", "ru", "tr", "el", "no",
] as const;

type Lang = (typeof TARGET_LANGS)[number];

export type TranslationResult = Record<Lang, { headline: string; description: string }>;

const SYSTEM_PROMPT = `You are a professional aviation marketplace translator for TradeAero.

Rules:
- IMPORTANT: If the input text contains content in MULTIPLE LANGUAGES (e.g. German followed by English translation, or any other bilingual/multilingual mix), you MUST first identify the PRIMARY language and extract ONLY that language's content. Remove all duplicate translations that the seller added manually. The primary language is typically the FIRST language block in the text. Do NOT translate already-translated content — strip it before translating.
- Translate the cleaned, single-language text into the requested target languages
- Preserve all technical aviation abbreviations exactly as-is: TBO, SMOH, TTAF, IFR, VFR, STOL, MTOW, ADS-B, TCAS, EFIS, etc.
- Preserve all brand names, model numbers, and manufacturer names exactly: Cessna, Piper, Garmin G1000, Pratt & Whitney PT6A, Rotax, etc.
- Use formal register in German (Sie-Form), French (vouvoiement), Spanish (usted), Italian (Lei-Form), Polish (Pan/Pani), Czech (Vy-form), Dutch (u-form), Swedish (ni-form), Portuguese (você-form), Russian (вы-form), Turkish (siz-form), Greek (εσείς-form), and Norwegian (De-form)
- Keep the same professional, concise marketing tone as the original
- Detect the source language automatically
- Return valid JSON only, no markdown`;

let client: Anthropic | null = null;

/** Cumulative token usage in this process */
let _totalInputTokens = 0;
let _totalOutputTokens = 0;

export function getTranslationTokenUsage(): { input: number; output: number } {
  return { input: _totalInputTokens, output: _totalOutputTokens };
}

export function resetTranslationTokenUsage(): void {
  _totalInputTokens = 0;
  _totalOutputTokens = 0;
}

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Translate headline and description into all 14 TradeAero locales using Claude Haiku 4.5.
 * Source language is auto-detected (typically German for crawled content).
 *
 * Bilingual content handling: The system prompt instructs Claude to detect and strip
 * duplicate translations (e.g. seller wrote in German then repeated in English).
 * Only the primary language content is translated, preventing mixed-language output.
 *
 * Returns null if translation fails (listing will be inserted with German only).
 */
export async function translateListing(
  headline: string,
  description: string,
  sourceLang: Lang = "de"
): Promise<TranslationResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn("ANTHROPIC_API_KEY not set, skipping translation");
    return null;
  }

  // Pre-clean: strip obvious bilingual separators and duplicate blocks
  const cleanedDescription = stripDuplicateLanguageBlocks(description);

  const targetLangs = TARGET_LANGS.filter((l) => l !== sourceLang);

  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Translate these fields into these target languages: ${JSON.stringify(targetLangs)}

Input (source language: ${sourceLang}):
${JSON.stringify({ headline, description: cleanedDescription })}

IMPORTANT: If the description contains bilingual/multilingual content (e.g. the same information repeated in different languages), extract ONLY the primary language content before translating. Do not include the seller's manual translation in the output.

Return a JSON object with this exact structure:
{
  "translations": {
    "en": { "headline": "...", "description": "..." },
    "fr": { "headline": "...", "description": "..." },
    ...
  }
}`,
        },
      ],
    });

    // Track token usage for cost reporting
    _totalInputTokens += response.usage?.input_tokens ?? 0;
    _totalOutputTokens += response.usage?.output_tokens ?? 0;

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse JSON from response (handle markdown wrapping, truncated output, trailing commas)
    let jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    // Fix trailing commas before closing braces/brackets (common LLM issue)
    jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");

    // If JSON is truncated (unterminated string/object), try to repair
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Attempt repair: close any unclosed strings and braces
      let repaired = jsonStr;
      // Count unbalanced quotes — if odd, add closing quote
      const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
      if (quoteCount % 2 !== 0) repaired += '"';
      // Close unclosed braces/brackets
      const opens = (repaired.match(/\{/g) || []).length;
      const closes = (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < opens - closes; i++) repaired += "}";
      const openBr = (repaired.match(/\[/g) || []).length;
      const closeBr = (repaired.match(/\]/g) || []).length;
      for (let i = 0; i < openBr - closeBr; i++) repaired += "]";
      // Remove trailing commas again after repair
      repaired = repaired.replace(/,\s*([\]}])/g, "$1");
      try {
        parsed = JSON.parse(repaired);
        logger.debug("Repaired truncated translation JSON");
      } catch (repairErr) {
        throw new Error(`Translation JSON parse failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`);
      }
    }
    const translations = parsed.translations as Record<
      string,
      { headline: string; description: string }
    >;

    // Build full result including source language
    // Use cleaned description for the source language entry too
    const result: Partial<TranslationResult> = {};
    result[sourceLang] = { headline, description: cleanedDescription };
    const missingLangs: string[] = [];
    for (const lang of targetLangs) {
      if (translations[lang]?.headline && translations[lang]?.description) {
        // Sanitize translated text (strip any HTML tags from LLM output)
        result[lang] = {
          headline: translations[lang].headline.replace(/<[^>]*>/g, "").trim(),
          description: translations[lang].description.replace(/<[^>]*>/g, "").trim(),
        };
      } else {
        // Fallback to source language text for missing locales
        missingLangs.push(lang);
        result[lang] = { headline, description: cleanedDescription };
      }
    }

    if (missingLangs.length > 0) {
      logger.warn("Translation incomplete — some locales fell back to source", {
        missing: missingLangs,
        headline: headline.slice(0, 50),
      });
    }

    logger.debug("Translated listing", {
      headline: headline.slice(0, 50),
      languages: Object.keys(result).length,
      missing: missingLangs.length,
    });

    return result as TranslationResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Translation failed, will insert German only", { error: msg });
    return null;
  }
}

/**
 * Pre-clean bilingual content before sending to Claude.
 *
 * Detects common patterns where sellers write content in one language
 * and then repeat it in another:
 * - Explicit separators: "---", "___", "English:", "Englisch:", etc.
 * - Near-duplicate paragraphs (same content repeated in a different language)
 * - Contact info duplicated at the end
 *
 * This is a best-effort heuristic pass. Claude's system prompt handles
 * remaining cases that regex can't catch.
 */
function stripDuplicateLanguageBlocks(text: string): string {
  if (!text || text.length < 100) return text;

  // 1. Split by explicit bilingual separators
  const separatorPatterns = [
    /\n\s*[-_]{3,}\s*\n/,                          // --- or ___ line separators
    /\n\s*(?:English|Englisch|Anglais|Inglés|Inglese)\s*[:：]\s*\n/i,
    /\n\s*(?:German|Deutsch|Allemand|Alemán|Tedesco)\s*[:：]\s*\n/i,
    /\n\s*(?:French|Français|Französisch)\s*[:：]\s*\n/i,
    /\n\s*(?:Translation|Übersetzung|Traduction)\s*[:：]\s*\n/i,
  ];

  for (const pattern of separatorPatterns) {
    const parts = text.split(pattern);
    if (parts.length >= 2) {
      // Keep the first (primary) block
      const primary = parts[0].trim();
      if (primary.length >= 50) {
        logger.debug("Stripped bilingual content after separator", {
          originalLen: text.length,
          cleanedLen: primary.length,
        });
        return primary;
      }
    }
  }

  // 2. Detect near-duplicate halves (same content repeated in another language)
  //    If the second half is roughly the same length as the first and the text
  //    is suspiciously long, it's likely bilingual repetition
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length >= 6) {
    const mid = Math.floor(sentences.length / 2);
    const firstHalf = sentences.slice(0, mid).join(" ");
    const secondHalf = sentences.slice(mid).join(" ");

    // Check if both halves are roughly the same length (within 40%)
    const ratio = firstHalf.length / secondHalf.length;
    if (ratio > 0.6 && ratio < 1.7) {
      // Check if they share significant technical terms (numbers, abbreviations)
      const techTerms = (s: string) => {
        const matches = s.match(/\b(?:TT|TTAF|SMOH|TTSN|TBO|IFR|VFR|MTOW|\d{3,}[hH]?|\d+\.\d+)\b/g);
        return new Set((matches || []).map(m => m.toUpperCase()));
      };
      const terms1 = techTerms(firstHalf);
      const terms2 = techTerms(secondHalf);
      if (terms1.size >= 2 && terms2.size >= 2) {
        let overlap = 0;
        for (const t of terms1) if (terms2.has(t)) overlap++;
        // If >50% of technical terms overlap, it's likely the same content in two languages
        if (overlap / Math.min(terms1.size, terms2.size) > 0.5) {
          logger.debug("Detected bilingual duplicate content via technical term overlap", {
            originalLen: text.length,
            cleanedLen: firstHalf.length,
            overlapRatio: overlap / Math.min(terms1.size, terms2.size),
          });
          return firstHalf;
        }
      }
    }
  }

  return text;
}
