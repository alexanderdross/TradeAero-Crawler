import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";

const TARGET_LANGS = [
  "en", "de", "fr", "es", "it", "pl", "cs", "sv", "nl", "pt", "ru", "tr", "el", "no",
] as const;

type Lang = (typeof TARGET_LANGS)[number];

export type TranslationResult = Record<Lang, { headline: string; description: string }>;

const SYSTEM_PROMPT = `You are a professional aviation marketplace translator for TradeAero.

Rules:
- Translate the provided aircraft listing text into the requested target languages
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
${JSON.stringify({ headline, description })}

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

    // Parse JSON from response (handle potential markdown wrapping)
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    const translations = parsed.translations as Record<
      string,
      { headline: string; description: string }
    >;

    // Build full result including source language
    // Validate completeness: ensure all 14 locales are populated
    const result: Partial<TranslationResult> = {};
    result[sourceLang] = { headline, description };
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
        result[lang] = { headline, description };
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
