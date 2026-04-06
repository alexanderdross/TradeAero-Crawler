import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";

export interface ExtractedListingData {
  engine_type_name?: string;
  engine_power?: string;
  engine_power_unit?: string;
  fuel_type?: string;
  total_time?: number;
  engine_hours?: number;
  cycles?: number;
  empty_weight?: string;
  empty_weight_unit?: string;
  max_takeoff_weight?: string;
  max_takeoff_weight_unit?: string;
  fuel_capacity?: string;
  fuel_capacity_unit?: string;
  cruise_speed?: string;
  cruise_speed_unit?: string;
  max_speed?: string;
  max_speed_unit?: string;
  max_range?: string;
  max_range_unit?: string;
  avionics_gps?: string;
  avionics_autopilot?: string;
  avionics_radios?: string;
  avionics_transponder?: string;
  avionics_weather_radar?: string;
  avionics_tcas?: string;
  avionics_other?: string;
  equipment?: string[];
  last_annual_inspection?: string;
  maintenance_program?: string;
  airworthy?: string;
  seats?: string;
  registration?: string;
  serial_number?: string;
  cleaned_description?: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic { if (!client) client = new Anthropic(); return client; }

let _extractInputTokens = 0;
let _extractOutputTokens = 0;
export function getExtractionTokenUsage() { return { input: _extractInputTokens, output: _extractOutputTokens }; }
export function resetExtractionTokenUsage() { _extractInputTokens = 0; _extractOutputTokens = 0; }

const EXTRACTION_SYSTEM_PROMPT = `You are a structured data extraction engine for an aviation marketplace.

Extract structured fields from aircraft listing descriptions. The text is often unstructured, mixing German and English, with technical data embedded in prose.

Rules:
- Extract ONLY data explicitly stated in the text. Never infer or guess.
- For engine type, extract the full designation (e.g. "Continental TSIO-360-FB", "Rotax 912 ULS")
- For hours/time, look for: TT 1549, TTAF 1549h, 235 STD SMOH, TTSN 450, Betriebsstunden 450
- For avionics, categorize into: GPS, autopilot, radios, transponder, weather radar, TCAS, other
- For equipment, extract items like: auxiliary fuel tanks, de-icing, oxygen system, cargo pod, floats, etc.
- For last_annual_inspection, return ONLY a valid ISO date (YYYY-MM-DD). If only month/year given, use the first of that month (e.g. "01.2025" → "2025-01-01"). If no clear date, omit the field entirely.
- Provide a cleaned_description with ONLY narrative/marketing text, all structured data removed. The cleaned_description MUST be at least 20 characters long.
- Return valid JSON only, no markdown`;

export async function extractStructuredData(
  title: string, description: string,
): Promise<ExtractedListingData | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!description || description.length < 30) return null;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      temperature: 0,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Extract structured data from this aircraft listing.

Title: ${title}
Description: ${description}

Return JSON with ONLY fields you can extract. Omit fields not mentioned.
{
  "engine_type_name": "full engine designation",
  "engine_power": "numeric value only",
  "engine_power_unit": "hp or kW",
  "fuel_type": "Avgas 100LL, MOGAS, Jet A-1, etc.",
  "total_time": numeric_TTAF_hours,
  "engine_hours": numeric_SMOH_hours,
  "cycles": numeric_landing_cycles,
  "empty_weight": "numeric", "empty_weight_unit": "kg or lbs",
  "max_takeoff_weight": "numeric", "max_takeoff_weight_unit": "kg or lbs",
  "fuel_capacity": "numeric", "fuel_capacity_unit": "L or USG",
  "cruise_speed": "numeric", "cruise_speed_unit": "kts or km/h",
  "max_speed": "numeric", "max_speed_unit": "kts or km/h",
  "max_range": "numeric", "max_range_unit": "nm or km",
  "avionics_gps": "GPS units",
  "avionics_autopilot": "autopilot system",
  "avionics_radios": "radio equipment",
  "avionics_transponder": "transponder model",
  "avionics_weather_radar": "weather radar",
  "avionics_tcas": "TCAS system",
  "avionics_other": "other avionics",
  "equipment": ["item1", "item2"],
  "seats": "number",
  "registration": "if mentioned",
  "serial_number": "if mentioned",
  "last_annual_inspection": "YYYY-MM-DD format ONLY",
  "maintenance_program": "program name",
  "airworthy": "yes/no",
  "cleaned_description": "narrative text only, specs removed, min 20 chars"
}`,
      }],
    });

    _extractInputTokens += response.usage?.input_tokens ?? 0;
    _extractOutputTokens += response.usage?.output_tokens ?? 0;

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    let jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");

    let parsed: ExtractedListingData;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      let repaired = jsonStr;
      const qc = (repaired.match(/(?<!\\)"/g) || []).length;
      if (qc % 2 !== 0) repaired += '"';
      const o = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < o; i++) repaired += "}";
      repaired = repaired.replace(/,\s*([\]}])/g, "$1");
      try { parsed = JSON.parse(repaired); }
      catch (err) { logger.warn("Extraction JSON parse failed", { error: String(err), title: title.slice(0, 50) }); return null; }
    }

    // Validate numeric fields
    if (parsed.total_time !== undefined) parsed.total_time = Number(parsed.total_time) || undefined;
    if (parsed.engine_hours !== undefined) parsed.engine_hours = Number(parsed.engine_hours) || undefined;
    if (parsed.cycles !== undefined) parsed.cycles = Number(parsed.cycles) || undefined;

    // Validate date field — must be valid ISO date (YYYY-MM-DD)
    if (parsed.last_annual_inspection) {
      const dateStr = parsed.last_annual_inspection.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
        // Try to parse common formats: "01.2025" → "2025-01-01", "MM/YYYY" → "YYYY-MM-01"
        const mmYyyy = dateStr.match(/^(\d{1,2})[./](\d{4})$/);
        if (mmYyyy) {
          parsed.last_annual_inspection = `${mmYyyy[2]}-${mmYyyy[1].padStart(2, "0")}-01`;
        } else {
          // Can't parse — drop the field
          delete parsed.last_annual_inspection;
        }
      }
    }

    // Validate cleaned description length
    if (parsed.cleaned_description && parsed.cleaned_description.trim().length < 20) {
      delete parsed.cleaned_description;
    }

    logger.debug("Extracted structured data", {
      title: title.slice(0, 50),
      fieldsFound: Object.keys(parsed).filter(k => k !== "cleaned_description").length,
    });
    return parsed;
  } catch (err) {
    logger.warn("Structured extraction failed", { error: String(err), title: title.slice(0, 50) });
    return null;
  }
}

export function applyExtractedData(record: Record<string, unknown>, extracted: ExtractedListingData): void {
  const set = (key: string, val: unknown) => {
    if (val !== undefined && val !== null && val !== "" &&
        (record[key] === null || record[key] === undefined || record[key] === "")) {
      record[key] = val;
    }
  };

  set("engine_type_name", extracted.engine_type_name);
  set("engine_power", extracted.engine_power);
  set("engine_power_unit", extracted.engine_power_unit);
  set("fuel_type", extracted.fuel_type);
  set("total_time", extracted.total_time);
  set("engine_hours", extracted.engine_hours);
  set("cycles", extracted.cycles);
  set("empty_weight", extracted.empty_weight);
  set("empty_weight_unit", extracted.empty_weight_unit);
  set("max_takeoff_weight", extracted.max_takeoff_weight);
  set("max_takeoff_weight_unit", extracted.max_takeoff_weight_unit);
  set("fuel_capacity", extracted.fuel_capacity);
  set("fuel_capacity_unit", extracted.fuel_capacity_unit);
  set("cruise_speed", extracted.cruise_speed);
  set("cruise_speed_unit", extracted.cruise_speed_unit);
  set("max_speed", extracted.max_speed);
  set("max_speed_unit", extracted.max_speed_unit);
  set("max_range", extracted.max_range);
  set("max_range_unit", extracted.max_range_unit);
  set("avionics_gps", extracted.avionics_gps);
  set("avionics_autopilot", extracted.avionics_autopilot);
  set("avionics_radios", extracted.avionics_radios);
  set("avionics_transponder", extracted.avionics_transponder);
  set("avionics_weather_radar", extracted.avionics_weather_radar);
  set("avionics_tcas", extracted.avionics_tcas);
  set("avionics_other", extracted.avionics_other);

  if (extracted.equipment?.length) {
    const existing = (record.features as string[] | null) ?? [];
    record.features = [...new Set([...existing, ...extracted.equipment])];
  }

  set("last_annual_inspection", extracted.last_annual_inspection);
  set("maintenance_program", extracted.maintenance_program);
  set("airworthy", extracted.airworthy);
  set("seats", extracted.seats);
  set("registration", extracted.registration);
  set("serial_number", extracted.serial_number);

  // Only update description if cleaned version is long enough for DB constraint
  if (extracted.cleaned_description && extracted.cleaned_description.trim().length >= 20) {
    record.description = extracted.cleaned_description;
  }
}
