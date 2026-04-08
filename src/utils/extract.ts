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
  landings?: number;
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
  service_ceiling?: string;
  service_ceiling_unit?: string;
  avionics_gps?: string;
  avionics_autopilot?: string;
  avionics_radios?: string;
  avionics_transponder?: string;
  avionics_weather_radar?: string;
  avionics_tcas?: string;
  avionics_other?: string;
  equipment?: string[];
  last_annual_inspection?: string;
  last_inspection?: string;
  maintenance_program?: string;
  airworthy?: string;
  seats?: string;
  max_passengers?: number;
  registration?: string;
  serial_number?: string;
  country?: string;
  city?: string;
  location?: string;
  icaocode?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  company?: string;
  cleaned_description?: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic { if (!client) client = new Anthropic(); return client; }

let _extractInputTokens = 0;
let _extractOutputTokens = 0;
export function getExtractionTokenUsage() { return { input: _extractInputTokens, output: _extractOutputTokens }; }
export function resetExtractionTokenUsage() { _extractInputTokens = 0; _extractOutputTokens = 0; }

/**
 * Remove duplicate paragraphs/sentences from description text.
 * Listings from aircraft24/aeromarkt often repeat content blocks.
 */
export function deduplicateDescription(text: string): string {
  if (!text) return text;

  // Split into paragraphs (double newline or period-space patterns)
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const para of paragraphs) {
    // Normalize for comparison: lowercase, strip whitespace
    const key = para.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length < 10) { unique.push(para); continue; }
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(para);
    }
  }

  let result = unique.join("\n\n");

  // Also deduplicate repeated sentences within a single paragraph
  const sentences = result.split(/(?<=[.!?])\s+/);
  const seenSentences = new Set<string>();
  const uniqueSentences: string[] = [];
  for (const s of sentences) {
    const sKey = s.toLowerCase().replace(/\s+/g, " ").trim();
    if (sKey.length < 20) { uniqueSentences.push(s); continue; }
    if (!seenSentences.has(sKey)) {
      seenSentences.add(sKey);
      uniqueSentences.push(s);
    }
  }

  return uniqueSentences.join(" ").trim();
}

const EXTRACTION_SYSTEM_PROMPT = `You are a structured data extraction engine for an aviation marketplace.

Extract structured fields from aircraft listing descriptions. The text is often unstructured, mixing German and English, with technical data embedded in prose.

Rules:
- Extract ONLY data explicitly stated in the text. Never infer or guess.
- For engine type, extract the full designation (e.g. "Continental TSIO-360-FB", "Rotax 912 ULS", "Honeywell TPE331-10")
- For engine power, extract the numeric value and unit separately (e.g. power: "250", unit: "hp")
- For hours/time, look for: TT 1549, TTAF 1549h, 235 STD SMOH, TTSN 450, Betriebsstunden 450, TSN 3200
- For landings, look for: Landings: 4230, Landungen: 1500, Cycles: 890
- For avionics, split into specific categories:
  - GPS: Garmin G1000, GTN 750, GNS 530, etc.
  - Autopilot: Garmin GFC 700, S-TEC 55, Collins APS-65, etc.
  - Radios: Collins VHF-20, Garmin COM, Nav/Com units
  - Transponder: Garmin GTX 327, GTX 345, Collins TDR-94
  - Weather radar: Honeywell RDR 2000, Garmin GWX 70
  - TCAS: Goodrich TRC 899, Honeywell TCAS II
  - Other: ELT, DME, ADF, radar altimeter, HF radio, CVR, FDR
- For location, extract: country name (in English), city/region, airport/ICAO code
- For contact, extract: person name, email address, phone number, company name
- For seats/passengers, look for: Six passenger, 4-place, Sitze: 2, max_passengers
- For interior, extract notable features as equipment items
- Provide a cleaned_description with ONLY narrative/marketing text, all structured data (specs, avionics lists, contact info) removed. Must be at least 20 characters.
- Return valid JSON only, no markdown`;

export async function extractStructuredData(
  title: string, description: string,
): Promise<ExtractedListingData | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!description || description.length < 30) return null;

  // Deduplicate description before sending to LLM (saves tokens, improves quality)
  const dedupedDescription = deduplicateDescription(description);

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
Description: ${dedupedDescription}

Return JSON with ONLY fields you can extract. Omit fields not mentioned.
{
  "engine_type_name": "full engine designation (e.g. Continental TSIO-360-FB)",
  "engine_power": "numeric value only",
  "engine_power_unit": "hp or kW",
  "fuel_type": "Avgas 100LL, MOGAS, Jet A-1, etc.",
  "total_time": numeric_TTAF_hours,
  "engine_hours": numeric_SMOH_hours,
  "cycles": numeric_engine_cycles,
  "landings": numeric_total_landings,
  "empty_weight": "numeric", "empty_weight_unit": "kg or lbs",
  "max_takeoff_weight": "numeric", "max_takeoff_weight_unit": "kg or lbs",
  "fuel_capacity": "numeric", "fuel_capacity_unit": "L or USG",
  "cruise_speed": "numeric", "cruise_speed_unit": "kts or km/h",
  "max_speed": "numeric", "max_speed_unit": "kts or km/h",
  "max_range": "numeric", "max_range_unit": "nm or km",
  "service_ceiling": "numeric", "service_ceiling_unit": "ft or m",
  "avionics_gps": "GPS/nav units (e.g. Dual Garmin GTN 750, GNS 530W)",
  "avionics_autopilot": "autopilot system (e.g. Garmin GFC 700, S-TEC 55X)",
  "avionics_radios": "radio equipment (e.g. Dual Collins VHF-20 Nav/Com)",
  "avionics_transponder": "transponder (e.g. Garmin GTX 345, Collins TDR-94D)",
  "avionics_weather_radar": "weather radar (e.g. Honeywell RDR 2000 ELT Kannad 406AF)",
  "avionics_tcas": "TCAS/TAS system (e.g. Goodrich TRC 899, Avidyne TAS620)",
  "avionics_other": "other avionics: DME, ADF, radar altimeter, ELT, HF radio, CVR, FDR",
  "equipment": ["notable equipment items: de-ice, oxygen, auxiliary tanks, cargo pod, floats, etc."],
  "seats": "number of seats as string",
  "max_passengers": numeric_max_passengers,
  "registration": "aircraft registration mark (e.g. D-IABC, N12345, HB-LXX)",
  "serial_number": "manufacturer serial/Werk-Nr.",
  "last_annual_inspection": "YYYY-MM-DD format ONLY",
  "last_inspection": "YYYY-MM-DD most recent inspection of any type",
  "maintenance_program": "program name if mentioned",
  "airworthy": "yes or no",
  "country": "country name in English (e.g. Germany, Pakistan, Switzerland)",
  "city": "city or region name",
  "icaocode": "ICAO airport code where aircraft is based (4 uppercase letters, e.g. LOGK, EDNY, LSZH, LOWW). Look for: Standort, based at, homebase, Flugplatz, ICAO",
  "location": "full location string (e.g. Middle East, Lahore Pakistan)",
  "contact_name": "contact person name",
  "contact_email": "email address",
  "contact_phone": "phone number with country code if available",
  "company": "company or operator name",
  "cleaned_description": "narrative/marketing text only, all specs/avionics/contact removed, min 20 chars"
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
    if (parsed.landings !== undefined) parsed.landings = Number(parsed.landings) || undefined;
    if (parsed.max_passengers !== undefined) parsed.max_passengers = Number(parsed.max_passengers) || undefined;

    // Validate date fields — must be valid ISO date (YYYY-MM-DD)
    for (const dateField of ["last_annual_inspection", "last_inspection"] as const) {
      if (parsed[dateField]) {
        const dateStr = (parsed[dateField] as string).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
          const mmYyyy = dateStr.match(/^(\d{1,2})[./](\d{4})$/);
          if (mmYyyy) {
            (parsed as any)[dateField] = `${mmYyyy[2]}-${mmYyyy[1].padStart(2, "0")}-01`;
          } else {
            delete (parsed as any)[dateField];
          }
        }
      }
    }

    // Validate cleaned description length
    if (parsed.cleaned_description && parsed.cleaned_description.trim().length < 20) {
      delete parsed.cleaned_description;
    }

    // Deduplicate cleaned description too
    if (parsed.cleaned_description) {
      parsed.cleaned_description = deduplicateDescription(parsed.cleaned_description);
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

  // Engine & power
  set("engine_type_name", extracted.engine_type_name);
  set("engine_power", extracted.engine_power);
  set("engine_power_unit", extracted.engine_power_unit);
  set("fuel_type", extracted.fuel_type);

  // Time & cycles
  set("total_time", extracted.total_time);
  set("engine_hours", extracted.engine_hours);
  set("cycles", extracted.cycles ?? extracted.landings);

  // Weight & fuel
  set("empty_weight", extracted.empty_weight);
  set("empty_weight_unit", extracted.empty_weight_unit);
  set("max_takeoff_weight", extracted.max_takeoff_weight);
  set("max_takeoff_weight_unit", extracted.max_takeoff_weight_unit);
  set("fuel_capacity", extracted.fuel_capacity);
  set("fuel_capacity_unit", extracted.fuel_capacity_unit);

  // Performance
  set("cruise_speed", extracted.cruise_speed);
  set("cruise_speed_unit", extracted.cruise_speed_unit);
  set("max_speed", extracted.max_speed);
  set("max_speed_unit", extracted.max_speed_unit);
  set("max_range", extracted.max_range);
  set("max_range_unit", extracted.max_range_unit);
  set("service_ceiling", extracted.service_ceiling);
  set("service_ceiling_unit", extracted.service_ceiling_unit);

  // Avionics (structured into individual fields)
  set("avionics_gps", extracted.avionics_gps);
  set("avionics_autopilot", extracted.avionics_autopilot);
  set("avionics_radios", extracted.avionics_radios);
  set("avionics_transponder", extracted.avionics_transponder);
  set("avionics_weather_radar", extracted.avionics_weather_radar);
  set("avionics_tcas", extracted.avionics_tcas);
  set("avionics_other", extracted.avionics_other);

  // Equipment
  if (extracted.equipment?.length) {
    const existing = (record.features as string[] | null) ?? [];
    record.features = [...new Set([...existing, ...extracted.equipment])];
  }

  // Maintenance
  set("last_annual_inspection", extracted.last_annual_inspection);
  set("last_inspection", extracted.last_inspection);
  set("maintenance_program", extracted.maintenance_program);
  set("airworthy", extracted.airworthy);

  // Capacity
  set("seats", extracted.seats);
  set("max_passengers", extracted.max_passengers);

  // Identification
  set("registration", extracted.registration);
  set("serial_number", extracted.serial_number);

  // Location (only fill if not already set from parser)
  set("country", extracted.country);
  set("city", extracted.city);
  set("icaocode", extracted.icaocode);
  if (extracted.location && !record.location) {
    record.location = extracted.location;
  }

  // Contact details (only fill if not already set)
  set("contact_name", extracted.contact_name);
  set("contact_email", extracted.contact_email);
  set("contact_phone", extracted.contact_phone);
  set("company", extracted.company);

  // Only update description if cleaned version is long enough for DB constraint
  if (extracted.cleaned_description && extracted.cleaned_description.trim().length >= 20) {
    record.description = extracted.cleaned_description;
  }
}
