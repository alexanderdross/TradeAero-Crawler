import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";

/**
 * Structured data extracted from a listing description by Claude.
 * All fields are optional — only populated if found in the text.
 */
export interface ExtractedListingData {
  // Engine
  engine_type_name?: string;    // e.g. "Continental TSIO-360-FB"
  engine_power?: string;        // e.g. "210"
  engine_power_unit?: string;   // "hp" or "kW"
  fuel_type?: string;           // e.g. "Avgas 100LL", "MOGAS", "Jet A-1"

  // Time
  total_time?: number;          // TTAF in hours
  engine_hours?: number;        // SMOH/STOH hours
  cycles?: number;              // Landing cycles

  // Weights
  empty_weight?: string;
  empty_weight_unit?: string;   // "kg" or "lbs"
  max_takeoff_weight?: string;
  max_takeoff_weight_unit?: string;
  fuel_capacity?: string;
  fuel_capacity_unit?: string;  // "L" or "USG"

  // Performance
  cruise_speed?: string;
  cruise_speed_unit?: string;   // "kts" or "km/h"
  max_speed?: string;
  max_speed_unit?: string;
  max_range?: string;
  max_range_unit?: string;      // "nm" or "km"

  // Avionics (individual fields)
  avionics_gps?: string;
  avionics_autopilot?: string;
  avionics_radios?: string;
  avionics_transponder?: string;
  avionics_weather_radar?: string;
  avionics_tcas?: string;
  avionics_other?: string;

  // Equipment / features as string array
  equipment?: string[];

  // Maintenance
  last_annual_inspection?: string;
  maintenance_program?: string;
  airworthy?: string;

  // Other
  seats?: string;
  registration?: string;
  serial_number?: string;

  // Cleaned description (narrative only, structured data removed)
  cleaned_description?: string;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Cumulative token usage for extraction calls */
let _extractInputTokens = 0;
let _extractOutputTokens = 0;

export function getExtractionTokenUsage(): { input: number; output: number } {
  return { input: _extractInputTokens, output: _extractOutputTokens };
}

export function resetExtractionTokenUsage(): void {
  _extractInputTokens = 0;
  _extractOutputTokens = 0;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a structured data extraction engine for an aviation marketplace.

Your job is to extract structured fields from aircraft listing descriptions written by sellers. The text is often unstructured, mixing German and English, with technical aviation data embedded in narrative prose.

Rules:
- Extract ONLY data explicitly stated in the text. Never infer or guess.
- For engine type, extract the full designation (e.g. "Continental TSIO-360-FB", "Rotax 912 ULS", "Lycoming IO-360-L2A")
- For hours/time, look for patterns like: TT 1549, TTAF 1549h, 235 STD SMOH, TTSN 450, Betriebsstunden 450
- For avionics, categorize into: GPS (Garmin G1000, GTN 750, etc.), autopilot (GFC 700, KAP 140, etc.), radios (COM/NAV, KX 155, etc.), transponder (GTX 330, Mode S, etc.), weather radar, TCAS, and other
- For equipment, extract items like: auxiliary fuel tanks, de-icing, oxygen system, cargo pod, floats, wheel fairings, tow hook, etc.
- Provide a cleaned_description that contains ONLY the narrative/marketing text, with all structured data (specs, avionics lists, equipment lists) removed
- Return valid JSON only, no markdown wrapping`;

/**
 * Extract structured data from a listing description using Claude Haiku.
 * This runs alongside translation — both use the same API key.
 *
 * Returns null if extraction fails (listing continues with unstructured data).
 */
export async function extractStructuredData(
  title: string,
  description: string,
): Promise<ExtractedListingData | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!description || description.length < 30) return null;

  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      temperature: 0,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Extract structured data from this aircraft listing.

Title: ${title}
Description: ${description}

Return a JSON object with ONLY the fields you can extract from the text. Omit fields not mentioned.

{
  "engine_type_name": "full engine designation if mentioned",
  "engine_power": "numeric value only",
  "engine_power_unit": "hp or kW",
  "fuel_type": "Avgas 100LL, MOGAS, Jet A-1, etc.",
  "total_time": numeric TTAF hours,
  "engine_hours": numeric SMOH/STOH hours,
  "cycles": numeric landing cycles,
  "empty_weight": "numeric value",
  "empty_weight_unit": "kg or lbs",
  "max_takeoff_weight": "numeric value",
  "max_takeoff_weight_unit": "kg or lbs",
  "fuel_capacity": "numeric value",
  "fuel_capacity_unit": "L or USG",
  "cruise_speed": "numeric value",
  "cruise_speed_unit": "kts or km/h",
  "max_speed": "numeric value",
  "max_speed_unit": "kts or km/h",
  "max_range": "numeric value",
  "max_range_unit": "nm or km",
  "avionics_gps": "GPS units found",
  "avionics_autopilot": "autopilot system",
  "avionics_radios": "radio equipment",
  "avionics_transponder": "transponder model",
  "avionics_weather_radar": "weather radar",
  "avionics_tcas": "TCAS/collision avoidance",
  "avionics_other": "other avionics",
  "equipment": ["item1", "item2"],
  "seats": "number of seats",
  "registration": "aircraft registration if mentioned",
  "serial_number": "serial number if mentioned",
  "last_annual_inspection": "date or description",
  "maintenance_program": "maintenance program",
  "airworthy": "yes/no or description",
  "cleaned_description": "narrative text only, all specs/lists removed"
}`,
        },
      ],
    });

    _extractInputTokens += response.usage?.input_tokens ?? 0;
    _extractOutputTokens += response.usage?.output_tokens ?? 0;

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // Parse JSON (handle markdown wrapping)
    let jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");

    let parsed: ExtractedListingData;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Attempt repair
      let repaired = jsonStr;
      const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
      if (quoteCount % 2 !== 0) repaired += '"';
      const opens = (repaired.match(/\{/g) || []).length;
      const closes = (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < opens - closes; i++) repaired += "}";
      repaired = repaired.replace(/,\s*([\]}])/g, "$1");
      try {
        parsed = JSON.parse(repaired);
      } catch (err) {
        logger.warn("Structured extraction JSON parse failed", {
          error: err instanceof Error ? err.message : String(err),
          title: title.slice(0, 50),
        });
        return null;
      }
    }

    // Validate numeric fields
    if (parsed.total_time !== undefined) {
      parsed.total_time = typeof parsed.total_time === "number" ? parsed.total_time : Number(parsed.total_time) || undefined;
    }
    if (parsed.engine_hours !== undefined) {
      parsed.engine_hours = typeof parsed.engine_hours === "number" ? parsed.engine_hours : Number(parsed.engine_hours) || undefined;
    }
    if (parsed.cycles !== undefined) {
      parsed.cycles = typeof parsed.cycles === "number" ? parsed.cycles : Number(parsed.cycles) || undefined;
    }

    logger.debug("Extracted structured data", {
      title: title.slice(0, 50),
      fieldsFound: Object.keys(parsed).filter(k => k !== "cleaned_description").length,
    });

    return parsed;
  } catch (err) {
    logger.warn("Structured extraction failed", {
      error: err instanceof Error ? err.message : String(err),
      title: title.slice(0, 50),
    });
    return null;
  }
}

/**
 * Apply extracted structured data to an aircraft record.
 * Only fills null/missing fields — never overwrites existing data.
 */
export function applyExtractedData(
  record: Record<string, unknown>,
  extracted: ExtractedListingData,
): void {
  const setIfMissing = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "" && (record[key] === null || record[key] === undefined || record[key] === "")) {
      record[key] = value;
    }
  };

  // Engine
  setIfMissing("engine_type_name", extracted.engine_type_name);
  setIfMissing("engine_power", extracted.engine_power);
  setIfMissing("engine_power_unit", extracted.engine_power_unit);
  setIfMissing("fuel_type", extracted.fuel_type);

  // Time
  setIfMissing("total_time", extracted.total_time);
  setIfMissing("engine_hours", extracted.engine_hours);
  setIfMissing("cycles", extracted.cycles);

  // Weights
  setIfMissing("empty_weight", extracted.empty_weight);
  setIfMissing("empty_weight_unit", extracted.empty_weight_unit);
  setIfMissing("max_takeoff_weight", extracted.max_takeoff_weight);
  setIfMissing("max_takeoff_weight_unit", extracted.max_takeoff_weight_unit);
  setIfMissing("fuel_capacity", extracted.fuel_capacity);
  setIfMissing("fuel_capacity_unit", extracted.fuel_capacity_unit);

  // Performance
  setIfMissing("cruise_speed", extracted.cruise_speed);
  setIfMissing("cruise_speed_unit", extracted.cruise_speed_unit);
  setIfMissing("max_speed", extracted.max_speed);
  setIfMissing("max_speed_unit", extracted.max_speed_unit);
  setIfMissing("max_range", extracted.max_range);
  setIfMissing("max_range_unit", extracted.max_range_unit);

  // Avionics
  setIfMissing("avionics_gps", extracted.avionics_gps);
  setIfMissing("avionics_autopilot", extracted.avionics_autopilot);
  setIfMissing("avionics_radios", extracted.avionics_radios);
  setIfMissing("avionics_transponder", extracted.avionics_transponder);
  setIfMissing("avionics_weather_radar", extracted.avionics_weather_radar);
  setIfMissing("avionics_tcas", extracted.avionics_tcas);
  setIfMissing("avionics_other", extracted.avionics_other);

  // Equipment → features array
  if (extracted.equipment && extracted.equipment.length > 0) {
    const existing = (record.features as string[] | null) ?? [];
    const merged = [...new Set([...existing, ...extracted.equipment])];
    record.features = merged;
  }

  // Maintenance
  setIfMissing("last_annual_inspection", extracted.last_annual_inspection);
  setIfMissing("maintenance_program", extracted.maintenance_program);
  setIfMissing("airworthy", extracted.airworthy);

  // Other
  setIfMissing("seats", extracted.seats);
  setIfMissing("registration", extracted.registration);
  setIfMissing("serial_number", extracted.serial_number);

  // Use cleaned description if available
  if (extracted.cleaned_description && extracted.cleaned_description.length >= 10) {
    record.description = extracted.cleaned_description;
  }
}
