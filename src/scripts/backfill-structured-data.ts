import { createClient } from "@supabase/supabase-js";
import { extractStructuredData, applyExtractedData, resetExtractionTokenUsage, getExtractionTokenUsage } from "../utils/extract.js";
import { translateListing, resetTranslationTokenUsage, getTranslationTokenUsage } from "../utils/translate.js";
import { buildLocaleFields } from "../db/locale-helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Backfill structured data for all existing external aircraft listings.
 *
 * Usage: npx tsx src/scripts/backfill-structured-data.ts [--dry-run] [--limit N] [--source name] [--retranslate]
 */

const supabase = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
);

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    limit: (() => { const i = args.indexOf("--limit"); return i >= 0 && args[i+1] ? parseInt(args[i+1], 10) : 0; })(),
    source: (() => { const i = args.indexOf("--source"); return i >= 0 && args[i+1] ? args[i+1] : null; })(),
    retranslate: args.includes("--retranslate"),
  };
}

async function main() {
  const opts = parseArgs();
  logger.info("Starting structured data backfill", opts);
  resetExtractionTokenUsage();
  resetTranslationTokenUsage();

  let query = supabase
    .from("aircraft_listings")
    .select("id, headline, description, source_name, engine_type_name, avionics_gps, avionics_autopilot, avionics_radios, avionics_transponder, avionics_other, total_time, engine_hours, fuel_type, empty_weight, max_takeoff_weight, seats, registration, serial_number, features")
    .eq("status", "active")
    .eq("is_external", true)
    .order("created_at", { ascending: false });

  if (opts.source) query = query.ilike("source_name", `%${opts.source}%`);
  if (opts.limit > 0) query = query.limit(opts.limit);

  const { data: listings, error } = await query;
  if (error) { logger.error("Failed to fetch listings", { error: error.message }); process.exit(1); }
  if (!listings?.length) { logger.info("No listings to process"); return; }

  logger.info(`Found ${listings.length} listings to process`);
  let updated = 0, skipped = 0, failed = 0;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const headline = listing.headline ?? "";
    const description = listing.description ?? "";
    if (!description || description.length < 30) { skipped++; continue; }

    try {
      const extracted = await extractStructuredData(headline, description);
      if (!extracted) { skipped++; continue; }

      const tempRecord: Record<string, unknown> = {
        engine_type_name: listing.engine_type_name, avionics_gps: listing.avionics_gps,
        avionics_autopilot: listing.avionics_autopilot, avionics_radios: listing.avionics_radios,
        avionics_transponder: listing.avionics_transponder, avionics_other: listing.avionics_other,
        total_time: listing.total_time, engine_hours: listing.engine_hours,
        fuel_type: listing.fuel_type, empty_weight: listing.empty_weight,
        max_takeoff_weight: listing.max_takeoff_weight, seats: listing.seats,
        registration: listing.registration, serial_number: listing.serial_number,
        features: listing.features,
      };

      applyExtractedData(tempRecord, extracted);

      const updateFields: Record<string, unknown> = {};
      for (const [key, newVal] of Object.entries(tempRecord)) {
        const oldVal = (listing as any)[key];
        if (newVal !== undefined && newVal !== null && newVal !== "" &&
            (oldVal === null || oldVal === undefined || oldVal === "")) {
          updateFields[key] = newVal;
        }
      }

      // Only update description if cleaned version passes DB constraint (>= 10 chars)
      // and is meaningfully shorter than the original (not just whitespace trimming)
      const cleanedDesc = extracted.cleaned_description;
      if (cleanedDesc && cleanedDesc.trim().length >= 20 &&
          cleanedDesc.length < description.length * 0.9) {
        updateFields.description = cleanedDesc;

        // Re-translate with cleaned description if requested
        if (opts.retranslate && process.env.ANTHROPIC_API_KEY) {
          try {
            const translations = await translateListing(headline, cleanedDesc, "de");
            if (translations) {
              const localeFields = buildLocaleFields(headline, cleanedDesc, translations);
              // Only include description_* and headline_* locale fields
              // NEVER include slug_* fields — they have unique constraints
              for (const [key, val] of Object.entries(localeFields)) {
                if (key.startsWith("slug_")) continue;
                updateFields[key] = val;
              }
            }
          } catch (err) { logger.warn(`Re-translation failed for ${listing.id}: ${err}`); }
        }
      }

      if (Object.keys(updateFields).length === 0) { skipped++; continue; }

      // Final safety: strip any slug fields that might have leaked through
      for (const key of Object.keys(updateFields)) {
        if (key.startsWith("slug")) delete updateFields[key];
      }

      logger.info(`[${i+1}/${listings.length}] ${headline.slice(0, 50)} — filling ${Object.keys(updateFields).length} fields`);

      if (!opts.dryRun) {
        const { error: ue } = await supabase.from("aircraft_listings")
          .update({ ...updateFields, updated_at: new Date().toISOString() }).eq("id", listing.id);
        if (ue) { logger.error(`Failed to update ${listing.id}: ${ue.message}`); failed++; continue; }
      }
      updated++;
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) { logger.error(`Error processing ${listing.id}: ${err}`); failed++; }
  }

  logger.info("Backfill complete", {
    total: listings.length, updated, skipped, failed, dryRun: opts.dryRun,
    extractionTokens: getExtractionTokenUsage(), translationTokens: getTranslationTokenUsage(),
  });
}

main().catch((err) => { logger.error("Backfill failed", { error: err }); process.exit(1); });
