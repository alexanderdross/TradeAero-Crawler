import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

/**
 * Seed the aircraft_reference_specs table with performance data
 * for common UL/LSA/microlight aircraft using Claude Haiku AI.
 *
 * Usage: npx tsx src/scripts/seed-reference-specs.ts
 */

const MODELS = [
  // Dynamic / Aerospool
  { manufacturer: "Dynamic", model: "WT-9", variant: "Dynamic" },
  { manufacturer: "Dynamic", model: "WT-9", variant: "Dynamic Club" },
  // Comco Ikarus
  { manufacturer: "Comco Ikarus", model: "C42", variant: "B" },
  { manufacturer: "Comco Ikarus", model: "C42", variant: "C" },
  { manufacturer: "Comco Ikarus", model: "C22", variant: null },
  // Flight Design
  { manufacturer: "Flight Design", model: "CT", variant: "CTLS" },
  { manufacturer: "Flight Design", model: "CT", variant: "CTSW" },
  { manufacturer: "Flight Design", model: "F2", variant: null },
  // Pipistrel
  { manufacturer: "Pipistrel", model: "Virus", variant: "SW 121" },
  { manufacturer: "Pipistrel", model: "Sinus", variant: "912" },
  { manufacturer: "Pipistrel", model: "Alpha Trainer", variant: null },
  // Tecnam
  { manufacturer: "Tecnam", model: "P92", variant: "Echo" },
  { manufacturer: "Tecnam", model: "P2002", variant: "Sierra" },
  { manufacturer: "Tecnam", model: "P2008", variant: "JC" },
  // Savage
  { manufacturer: "Zlin Savage", model: "Savage Cub", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Cruiser", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Bobber", variant: null },
  // AutoGyro
  { manufacturer: "AutoGyro", model: "Calidus", variant: null },
  { manufacturer: "AutoGyro", model: "Cavalon", variant: null },
  { manufacturer: "AutoGyro", model: "MTOsport", variant: null },
  // Aeropilot
  { manufacturer: "Aeropilot", model: "Legend 600", variant: null },
  // Evektor
  { manufacturer: "Evektor", model: "EV-97", variant: "Eurostar" },
  { manufacturer: "Evektor", model: "SportStar", variant: "RTC" },
  // Remos
  { manufacturer: "Remos", model: "GX", variant: null },
  { manufacturer: "Remos", model: "G-3", variant: "600" },
  // Pioneer
  { manufacturer: "Pioneer", model: "300", variant: null },
  { manufacturer: "Pioneer", model: "300", variant: "Griffon" },
  // FK Lightplanes
  { manufacturer: "FK Lightplanes", model: "FK9", variant: "ELA" },
  { manufacturer: "FK Lightplanes", model: "FK131", variant: null },
  { manufacturer: "FK Lightplanes", model: "FK14", variant: "Polaris" },
  // Roland Aircraft
  { manufacturer: "Roland", model: "Z602", variant: null },
  { manufacturer: "Roland", model: "Z601", variant: null },
  // ICP
  { manufacturer: "ICP", model: "Savannah", variant: "S" },
  { manufacturer: "ICP", model: "Savannah", variant: "XL" },
  // Eurofox
  { manufacturer: "Aeropro", model: "Eurofox", variant: null },
  // FlySynthesis
  { manufacturer: "FlySynthesis", model: "Storch", variant: null },
  { manufacturer: "FlySynthesis", model: "Texan", variant: null },
  // TL Ultralight
  { manufacturer: "TL Ultralight", model: "TL-3000 Sirius", variant: null },
  { manufacturer: "TL Ultralight", model: "TL-2000 Sting", variant: "S4" },
  // Rotax engines reference
  { manufacturer: "DynAero", model: "MCR 01", variant: "ULC" },
  // Heller
  { manufacturer: "Heller", model: "UL Sprint", variant: null },
  // Zenair
  { manufacturer: "Zenair", model: "CH701", variant: "STOL" },
  { manufacturer: "Zenair", model: "CH750", variant: null },
  // Aeroprakt
  { manufacturer: "Aeroprakt", model: "A-22", variant: "Foxbat" },
  { manufacturer: "Aeroprakt", model: "A-32", variant: "Vixxen" },
  // BRM Aero
  { manufacturer: "BRM Aero", model: "Bristell", variant: "NG5" },
  // Vampire
  { manufacturer: "Vampire", model: "FM250", variant: null },
  // Fresh Breeze (Paramotor trikes)
  { manufacturer: "Fresh Breeze", model: "XCitor", variant: null },
];

const SYSTEM_PROMPT = `You are an aviation engineer providing accurate aircraft performance specifications.

Given an aircraft manufacturer, model, and optional variant, return the standard performance specs as JSON.

Use metric units. Only include data you are confident about. For values you're unsure of, use null.

Return ONLY valid JSON with this exact structure (no markdown):
{
  "cruise_speed": "185",
  "max_speed": "220",
  "max_range": "1200",
  "service_ceiling": "15000",
  "climb_rate": "5.5",
  "takeoff_distance": "200",
  "landing_distance": "180",
  "fuel_consumption": "18",
  "empty_weight": "310",
  "max_takeoff_weight": "600",
  "max_payload": "290",
  "fuel_capacity": "100",
  "engine_type": "Rotax 912 ULS",
  "engine_power": "100",
  "fuel_type": "MOGAS",
  "seats": "2"
}`;

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey || !anthropicKey) {
    console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic();

  console.log(`Seeding ${MODELS.length} aircraft reference specs...\n`);

  let success = 0;
  let failed = 0;

  for (const model of MODELS) {
    const label = `${model.manufacturer} ${model.model}${model.variant ? ` ${model.variant}` : ""}`;

    try {
      // Check if already exists
      const { data: existing } = await supabase
        .from("aircraft_reference_specs")
        .select("id")
        .eq("manufacturer", model.manufacturer)
        .eq("model", model.model)
        .eq("variant", model.variant ?? "")
        .maybeSingle();

      if (existing) {
        console.log(`  SKIP ${label} (already exists)`);
        continue;
      }

      // Ask Claude for specs
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `Aircraft: ${label}\nPlease provide the standard performance specifications.`,
        }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const specs = JSON.parse(jsonStr);

      // Insert into DB
      const { error } = await supabase.from("aircraft_reference_specs").insert({
        manufacturer: model.manufacturer,
        model: model.model,
        variant: model.variant ?? "",
        cruise_speed: specs.cruise_speed,
        max_speed: specs.max_speed,
        max_range: specs.max_range,
        service_ceiling: specs.service_ceiling,
        climb_rate: specs.climb_rate,
        takeoff_distance: specs.takeoff_distance,
        landing_distance: specs.landing_distance,
        fuel_consumption: specs.fuel_consumption,
        empty_weight: specs.empty_weight,
        max_takeoff_weight: specs.max_takeoff_weight,
        max_payload: specs.max_payload,
        fuel_capacity: specs.fuel_capacity,
        engine_type: specs.engine_type,
        engine_power: specs.engine_power,
        engine_power_unit: "PS",
        fuel_type: specs.fuel_type,
        seats: specs.seats ?? "2",
        source: "claude-haiku",
        confidence: "high",
      });

      if (error) {
        console.log(`  FAIL ${label}: ${error.message}`);
        failed++;
      } else {
        console.log(`  OK   ${label}`);
        success++;
      }

      // Polite delay
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL ${label}: ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} seeded, ${failed} failed, ${MODELS.length - success - failed} skipped`);
}

main().catch(console.error);
