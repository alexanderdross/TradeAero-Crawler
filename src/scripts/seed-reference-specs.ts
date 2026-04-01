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
  // ===== ULTRALIGHT / LSA / MICROLIGHT =====
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
  { manufacturer: "Flight Design", model: "CT", variant: "CTLSi" },
  { manufacturer: "Flight Design", model: "F2", variant: null },
  // Pipistrel / Textron eAviation
  { manufacturer: "Pipistrel", model: "Virus", variant: "SW 121" },
  { manufacturer: "Pipistrel", model: "Virus", variant: "SW 80" },
  { manufacturer: "Pipistrel", model: "Sinus", variant: "912" },
  { manufacturer: "Pipistrel", model: "Alpha Trainer", variant: null },
  { manufacturer: "Pipistrel", model: "Panthera", variant: null },
  { manufacturer: "Pipistrel", model: "Velis Electro", variant: null },
  // Tecnam
  { manufacturer: "Tecnam", model: "P92", variant: "Echo" },
  { manufacturer: "Tecnam", model: "P92", variant: "Eaglet" },
  { manufacturer: "Tecnam", model: "P2002", variant: "Sierra" },
  { manufacturer: "Tecnam", model: "P2008", variant: "JC" },
  { manufacturer: "Tecnam", model: "P2006T", variant: null },
  { manufacturer: "Tecnam", model: "P2010", variant: null },
  { manufacturer: "Tecnam", model: "P-Mentor", variant: null },
  // Savage / Zlin
  { manufacturer: "Zlin Savage", model: "Savage Cub", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Cruiser", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Bobber", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Norden", variant: null },
  // AutoGyro
  { manufacturer: "AutoGyro", model: "Calidus", variant: null },
  { manufacturer: "AutoGyro", model: "Cavalon", variant: null },
  { manufacturer: "AutoGyro", model: "Cavalon", variant: "Pro" },
  { manufacturer: "AutoGyro", model: "MTOsport", variant: null },
  { manufacturer: "AutoGyro", model: "MTO", variant: "Classic" },
  // Aeropilot
  { manufacturer: "Aeropilot", model: "Legend 600", variant: null },
  { manufacturer: "Aeropilot", model: "Legend 540", variant: null },
  // Evektor
  { manufacturer: "Evektor", model: "EV-97", variant: "Eurostar" },
  { manufacturer: "Evektor", model: "EV-97", variant: "Harmony" },
  { manufacturer: "Evektor", model: "SportStar", variant: "RTC" },
  // Remos
  { manufacturer: "Remos", model: "GX", variant: null },
  { manufacturer: "Remos", model: "GXiS", variant: null },
  { manufacturer: "Remos", model: "G-3", variant: "600" },
  // Pioneer
  { manufacturer: "Pioneer", model: "300", variant: null },
  { manufacturer: "Pioneer", model: "300", variant: "Griffon" },
  { manufacturer: "Pioneer", model: "200", variant: null },
  // FK Lightplanes
  { manufacturer: "FK Lightplanes", model: "FK9", variant: "ELA" },
  { manufacturer: "FK Lightplanes", model: "FK9", variant: "Mark VI" },
  { manufacturer: "FK Lightplanes", model: "FK131", variant: null },
  { manufacturer: "FK Lightplanes", model: "FK14", variant: "Polaris" },
  // Roland Aircraft
  { manufacturer: "Roland", model: "Z602", variant: null },
  { manufacturer: "Roland", model: "Z601", variant: null },
  // ICP
  { manufacturer: "ICP", model: "Savannah", variant: "S" },
  { manufacturer: "ICP", model: "Savannah", variant: "XL" },
  { manufacturer: "ICP", model: "Ventura", variant: null },
  // Eurofox
  { manufacturer: "Aeropro", model: "Eurofox", variant: null },
  { manufacturer: "Aeropro", model: "Eurofox", variant: "3K" },
  // FlySynthesis
  { manufacturer: "FlySynthesis", model: "Storch", variant: null },
  { manufacturer: "FlySynthesis", model: "Texan", variant: null },
  // TL Ultralight
  { manufacturer: "TL Ultralight", model: "TL-3000 Sirius", variant: null },
  { manufacturer: "TL Ultralight", model: "TL-2000 Sting", variant: "S4" },
  { manufacturer: "TL Ultralight", model: "TL-96 Star", variant: null },
  // DynAero
  { manufacturer: "DynAero", model: "MCR 01", variant: "ULC" },
  { manufacturer: "DynAero", model: "MCR 4S", variant: null },
  // Heller
  { manufacturer: "Heller", model: "UL Sprint", variant: null },
  // Zenair
  { manufacturer: "Zenair", model: "CH701", variant: "STOL" },
  { manufacturer: "Zenair", model: "CH750", variant: null },
  { manufacturer: "Zenair", model: "CH650", variant: null },
  // Aeroprakt
  { manufacturer: "Aeroprakt", model: "A-22", variant: "Foxbat" },
  { manufacturer: "Aeroprakt", model: "A-22", variant: "LS" },
  { manufacturer: "Aeroprakt", model: "A-32", variant: "Vixxen" },
  // BRM Aero
  { manufacturer: "BRM Aero", model: "Bristell", variant: "NG5" },
  { manufacturer: "BRM Aero", model: "Bristell", variant: "B23" },
  // Vampire
  { manufacturer: "Vampire", model: "FM250", variant: null },
  // Fresh Breeze (Paramotor trikes)
  { manufacturer: "Fresh Breeze", model: "XCitor", variant: null },
  // Rans
  { manufacturer: "Rans", model: "S-6", variant: "Coyote II" },
  { manufacturer: "Rans", model: "S-7", variant: "Courier" },
  { manufacturer: "Rans", model: "S-19", variant: "Venterra" },
  { manufacturer: "Rans", model: "S-21", variant: "Outbound" },
  // Rotax Wing (Trike/Weightshift)
  { manufacturer: "Air Creation", model: "Tanarg", variant: null },
  { manufacturer: "Air Creation", model: "Clipper", variant: null },
  { manufacturer: "Air Creation", model: "iXess", variant: null },
  // Magni Gyro
  { manufacturer: "Magni", model: "M16", variant: null },
  { manufacturer: "Magni", model: "M22", variant: null },
  { manufacturer: "Magni", model: "M24", variant: "Orion" },
  // Celier Aviation
  { manufacturer: "Celier", model: "Xenon", variant: null },
  // Blackshape
  { manufacturer: "Blackshape", model: "Prime", variant: null },
  { manufacturer: "Blackshape", model: "Gabriel", variant: null },
  // Tomark
  { manufacturer: "Tomark", model: "Viper SD-4", variant: null },
  // Shark Aero
  { manufacturer: "Shark Aero", model: "Shark", variant: "UL" },
  // Atec
  { manufacturer: "Atec", model: "Faeta", variant: "321" },
  { manufacturer: "Atec", model: "Zephyr", variant: "2000" },
  // Eurostar / Ekolot
  { manufacturer: "Ekolot", model: "JK-05", variant: "Junior" },
  // Czech Sport Aircraft
  { manufacturer: "Czech Sport Aircraft", model: "PS-28", variant: "Cruiser" },
  { manufacturer: "Czech Sport Aircraft", model: "SportCruiser", variant: null },
  // Sling Aircraft
  { manufacturer: "Sling Aircraft", model: "Sling 2", variant: null },
  { manufacturer: "Sling Aircraft", model: "Sling 4", variant: null },
  { manufacturer: "Sling Aircraft", model: "Sling TSi", variant: null },
  // Van's Aircraft (Experimental)
  { manufacturer: "Vans", model: "RV-7", variant: null },
  { manufacturer: "Vans", model: "RV-8", variant: null },
  { manufacturer: "Vans", model: "RV-9", variant: null },
  { manufacturer: "Vans", model: "RV-10", variant: null },
  { manufacturer: "Vans", model: "RV-12", variant: null },
  { manufacturer: "Vans", model: "RV-14", variant: null },

  // ===== SINGLE ENGINE PISTON =====
  // Cessna
  { manufacturer: "Cessna", model: "150", variant: null },
  { manufacturer: "Cessna", model: "152", variant: null },
  { manufacturer: "Cessna", model: "172", variant: "Skyhawk" },
  { manufacturer: "Cessna", model: "172", variant: "SP" },
  { manufacturer: "Cessna", model: "177", variant: "Cardinal" },
  { manufacturer: "Cessna", model: "182", variant: "Skylane" },
  { manufacturer: "Cessna", model: "206", variant: "Stationair" },
  { manufacturer: "Cessna", model: "210", variant: "Centurion" },
  { manufacturer: "Cessna", model: "TTx", variant: null },
  // Piper
  { manufacturer: "Piper", model: "PA-28", variant: "Cherokee" },
  { manufacturer: "Piper", model: "PA-28", variant: "Warrior" },
  { manufacturer: "Piper", model: "PA-28", variant: "Archer" },
  { manufacturer: "Piper", model: "PA-28", variant: "Arrow" },
  { manufacturer: "Piper", model: "PA-32", variant: "Saratoga" },
  { manufacturer: "Piper", model: "PA-32", variant: "Lance" },
  { manufacturer: "Piper", model: "PA-18", variant: "Super Cub" },
  { manufacturer: "Piper", model: "PA-22", variant: "Tri-Pacer" },
  { manufacturer: "Piper", model: "PA-38", variant: "Tomahawk" },
  { manufacturer: "Piper", model: "PA-46", variant: "Malibu" },
  { manufacturer: "Piper", model: "PA-46", variant: "Matrix" },
  // Beechcraft
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "A36" },
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "G36" },
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "V35" },
  { manufacturer: "Beechcraft", model: "Musketeer", variant: null },
  { manufacturer: "Beechcraft", model: "Sierra", variant: null },
  { manufacturer: "Beechcraft", model: "Sundowner", variant: null },
  // Cirrus
  { manufacturer: "Cirrus", model: "SR20", variant: null },
  { manufacturer: "Cirrus", model: "SR22", variant: null },
  { manufacturer: "Cirrus", model: "SR22T", variant: null },
  // Diamond
  { manufacturer: "Diamond", model: "DA20", variant: "Katana" },
  { manufacturer: "Diamond", model: "DA40", variant: "Diamond Star" },
  { manufacturer: "Diamond", model: "DA42", variant: "Twin Star" },
  { manufacturer: "Diamond", model: "DA50", variant: "RG" },
  { manufacturer: "Diamond", model: "DA62", variant: null },
  // Mooney
  { manufacturer: "Mooney", model: "M20", variant: "Ovation" },
  { manufacturer: "Mooney", model: "M20", variant: "Acclaim" },
  { manufacturer: "Mooney", model: "M20", variant: "Bravo" },
  // Robin
  { manufacturer: "Robin", model: "DR400", variant: null },
  { manufacturer: "Robin", model: "DR400", variant: "180R" },
  { manufacturer: "Robin", model: "HR200", variant: null },
  // Grumman
  { manufacturer: "Grumman", model: "AA-5", variant: "Tiger" },
  { manufacturer: "Grumman", model: "AA-1", variant: "Yankee" },
  // Socata / Daher
  { manufacturer: "Socata", model: "TB-10", variant: "Tobago" },
  { manufacturer: "Socata", model: "TB-20", variant: "Trinidad" },
  { manufacturer: "Socata", model: "TB-9", variant: "Tampico" },
  { manufacturer: "Socata", model: "Rallye", variant: null },
  // Extra
  { manufacturer: "Extra", model: "EA-300", variant: null },
  { manufacturer: "Extra", model: "EA-330", variant: null },
  // Maule
  { manufacturer: "Maule", model: "MX-7", variant: null },
  { manufacturer: "Maule", model: "M-7", variant: null },
  // Husky
  { manufacturer: "Aviat", model: "Husky", variant: "A-1C" },
  // American Champion
  { manufacturer: "American Champion", model: "Scout", variant: null },
  { manufacturer: "American Champion", model: "Decathlon", variant: null },
  // CubCrafters
  { manufacturer: "CubCrafters", model: "Carbon Cub", variant: "EX-3" },
  { manufacturer: "CubCrafters", model: "XCub", variant: null },
  { manufacturer: "CubCrafters", model: "NXCub", variant: null },

  // ===== MULTI ENGINE PISTON =====
  { manufacturer: "Piper", model: "PA-34", variant: "Seneca" },
  { manufacturer: "Piper", model: "PA-44", variant: "Seminole" },
  { manufacturer: "Piper", model: "PA-23", variant: "Aztec" },
  { manufacturer: "Beechcraft", model: "Baron", variant: "58" },
  { manufacturer: "Beechcraft", model: "Baron", variant: "G58" },
  { manufacturer: "Beechcraft", model: "Duchess", variant: null },
  { manufacturer: "Cessna", model: "310", variant: null },
  { manufacturer: "Cessna", model: "340", variant: null },
  { manufacturer: "Cessna", model: "402", variant: null },
  { manufacturer: "Cessna", model: "414", variant: null },

  // ===== TURBOPROP =====
  { manufacturer: "Daher", model: "TBM 960", variant: null },
  { manufacturer: "Daher", model: "TBM 940", variant: null },
  { manufacturer: "Daher", model: "TBM 930", variant: null },
  { manufacturer: "Daher", model: "TBM 900", variant: null },
  { manufacturer: "Daher", model: "TBM 850", variant: null },
  { manufacturer: "Pilatus", model: "PC-12", variant: "NGX" },
  { manufacturer: "Pilatus", model: "PC-12", variant: "NG" },
  { manufacturer: "Pilatus", model: "PC-6", variant: "Porter" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "250" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "350" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "90" },
  { manufacturer: "Piper", model: "PA-46", variant: "Meridian" },
  { manufacturer: "Piper", model: "M600", variant: "SLS" },
  { manufacturer: "Cessna", model: "208", variant: "Caravan" },
  { manufacturer: "Cessna", model: "208B", variant: "Grand Caravan" },
  { manufacturer: "Epic", model: "E1000", variant: "GX" },

  // ===== VERY LIGHT JET / LIGHT JET =====
  { manufacturer: "Cirrus", model: "SF50", variant: "Vision Jet" },
  { manufacturer: "Eclipse", model: "550", variant: null },
  { manufacturer: "Cessna", model: "Citation Mustang", variant: null },
  { manufacturer: "Cessna", model: "Citation CJ3+", variant: null },
  { manufacturer: "Cessna", model: "Citation CJ4", variant: null },
  { manufacturer: "Cessna", model: "Citation M2+", variant: null },
  { manufacturer: "Embraer", model: "Phenom 100", variant: "EV" },
  { manufacturer: "Embraer", model: "Phenom 300", variant: "E" },
  { manufacturer: "HondaJet", model: "HA-420", variant: "Elite II" },

  // ===== MID-SIZE / SUPER MID-SIZE JET =====
  { manufacturer: "Cessna", model: "Citation XLS+", variant: null },
  { manufacturer: "Cessna", model: "Citation Latitude", variant: null },
  { manufacturer: "Cessna", model: "Citation Longitude", variant: null },
  { manufacturer: "Bombardier", model: "Challenger 350", variant: null },
  { manufacturer: "Bombardier", model: "Challenger 3500", variant: null },
  { manufacturer: "Embraer", model: "Praetor 500", variant: null },
  { manufacturer: "Embraer", model: "Praetor 600", variant: null },
  { manufacturer: "Gulfstream", model: "G280", variant: null },
  { manufacturer: "Dassault", model: "Falcon 2000", variant: "LXS" },

  // ===== HEAVY / ULTRA LONG RANGE JET =====
  { manufacturer: "Gulfstream", model: "G650", variant: "ER" },
  { manufacturer: "Gulfstream", model: "G700", variant: null },
  { manufacturer: "Gulfstream", model: "G550", variant: null },
  { manufacturer: "Bombardier", model: "Global 7500", variant: null },
  { manufacturer: "Bombardier", model: "Global 6500", variant: null },
  { manufacturer: "Dassault", model: "Falcon 8X", variant: null },
  { manufacturer: "Dassault", model: "Falcon 7X", variant: null },
  { manufacturer: "Dassault", model: "Falcon 6X", variant: null },

  // ===== HELICOPTER =====
  { manufacturer: "Robinson", model: "R22", variant: null },
  { manufacturer: "Robinson", model: "R44", variant: "Raven II" },
  { manufacturer: "Robinson", model: "R66", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H125", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H130", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H135", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H145", variant: null },
  { manufacturer: "Bell", model: "206", variant: "JetRanger" },
  { manufacturer: "Bell", model: "407", variant: "GXi" },
  { manufacturer: "Bell", model: "505", variant: "Jet Ranger X" },
  { manufacturer: "Leonardo", model: "AW109", variant: "Trekker" },
  { manufacturer: "Leonardo", model: "AW169", variant: null },
  { manufacturer: "MD Helicopters", model: "MD 500", variant: "E" },
  { manufacturer: "MD Helicopters", model: "MD 530F", variant: null },
  { manufacturer: "Guimbal", model: "Cabri G2", variant: null },
  { manufacturer: "Schweizer", model: "300", variant: "CBi" },

  // ===== EXPERIMENTAL / HOMEBUILT =====
  { manufacturer: "Lancair", model: "Evolution", variant: null },
  { manufacturer: "Lancair", model: "IV-P", variant: null },
  { manufacturer: "Glasair", model: "Sportsman", variant: null },
  { manufacturer: "Glasair", model: "GlaStar", variant: null },
  { manufacturer: "Murphy", model: "Moose", variant: null },
  { manufacturer: "Murphy", model: "Rebel", variant: null },
  { manufacturer: "Sonex", model: "Sonex", variant: null },
  { manufacturer: "Sonex", model: "Waiex", variant: null },
  // Pitts
  { manufacturer: "Pitts", model: "S-1", variant: "Special" },
  { manufacturer: "Pitts", model: "S-2", variant: "Special" },
  // Sbach / XtremeAir
  { manufacturer: "XtremeAir", model: "Sbach 300", variant: null },
  { manufacturer: "XtremeAir", model: "Sbach 342", variant: null },
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
