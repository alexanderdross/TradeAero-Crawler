import { createClient } from "@supabase/supabase-js";
import { extractStructuredData, applyExtractedData, resetExtractionTokenUsage, getExtractionTokenUsage } from "../utils/extract.js";
import { translateListing, resetTranslationTokenUsage, getTranslationTokenUsage } from "../utils/translate.js";
import { buildLocaleFields } from "../db/locale-helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Backfill structured data for all existing external aircraft listings.
 *
 * For each listing:
 * 1. Runs extractStructuredData() on the description
 * 2. Applies extracted fields (engine, avionics, equipment, weights, etc.)
 * 3. Uses cleaned description for re-translation if description changed
 * 4. Updates the DB record (only fills null/missing fields)
 *
 * Usage: npx tsx src/scripts/backfill-structured-data.ts [--dry-run] [--limit N] [--source helmut|aircraft24|aeromarkt]
 */

const supabase = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
);

interface BackfillOptions {
  dryRun: boolean;
  limit: number;
  source: string | null;
  retranslate: boolean;
}

function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    limit: (() => {
      const idx = args.indexOf("--limit");
      return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 0;
    })(),
    source: (() => {
      const idx = args.indexOf("--source");
      return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
    })(),
    retranslate: args.includes("--retranslate"),
  };
}

async function main() {
  const opts = parseArgs();
  logger.info("Starting structured data backfill", opts);

  resetExtractionTokenUsage();
  resetTranslationTokenUsage();

  // Fetch all active external listings
  let query = supabase
    .from("aircraft_listings")
    .select("id, headline, description, source_name, engine_type_name, avionics_gps, avionics_autopilot, avionics_radios, avionics_transponder, avionics_other, total_time, engine_hours, fuel_type, empty_weight, max_takeoff_weight, seats, registration, serial_number, features")
    .eq("status", "active")
    .eq("is_external", true)
    .order("created_at", { ascending: false });

  if (opts.source) {
    query = query.ilike("source_name", `%${opts.source}%`);
  }

  if (opts.limit > 0) {
    query = query.limit(opts.limit);
  }

  const { data: listings, error } = await query;

  if (error) {
    logger.error("Failed to fetch listings", { error: error.message });
    process.exit(1);
  }

  if (!listings || listings.length === 0) {
    logger.info("No listings to process");
    return;
  }

  logger.info(`Found ${listings.length} listings to process`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const headline = listing.headline ?? "";
    const description = listing.description ?? "";

    if (!description || description.length < 30) {
      skipped++;
      continue;
    }

    try {
      // Extract structured data
      const extracted = await extractStructuredData(headline, description);

      if (!extracted) {
        skipped++;
        continue;
      }

      // Count how many new fields would be populated
      const updateFields: Record<string, unknown> = {};
      const tempRecord: Record<string, unknown> = {
        engine_type_name: listing.engine_type_name,
        avionics_gps: listing.avionics_gps,
        avionics_autopilot: listing.avionics_autopilot,
        avionics_radios: listing.avionics_radios,
        avionics_transponder: listing.avionics_transponder,
        avionics_other: listing.avionics_other,
        total_time: listing.total_time,
        engine_hours: listing.engine_hours,
        fuel_type: listing.fuel_type,
        empty_weight: listing.empty_weight,
        max_takeoff_weight: listing.max_takeoff_weight,
        seats: listing.seats,
        registration: listing.registration,
        serial_number: listing.serial_number,
        features: listing.features,
      };

      applyExtractedData(tempRecord, extracted);

      // Collect only fields that actually changed (were null, now have values)
      for (const [key, newVal] of Object.entries(tempRecord)) {
        const oldVal = (listing as any)[key];
        if (newVal !== undefined && newVal !== null && newVal !== "" &&
            (oldVal === null || oldVal === undefined || oldVal === "")) {
          updateFields[key] = newVal;
        }
      }

      // Also update description if cleaned version is significantly shorter
      if (extracted.cleaned_description &&
          extracted.cleaned_description.length >= 10 &&
          extracted.cleaned_description.length < description.length * 0.9) {
        updateFields.description = extracted.cleaned_description;

        // Re-translate with cleaned description if requested
        if (opts.retranslate && process.env.ANTHROPIC_API_KEY) {
          try {
            const translations = await translateListing(headline, extracted.cleaned_description, "de");
            if (translations) {
              const localeFields = buildLocaleFields(headline, extracted.cleaned_description, translations);
              Object.assign(updateFields, localeFields);
              logger.debug(`Re-translated listing ${listing.id}`);
            }
          } catch (err) {
            logger.warn(`Re-translation failed for ${listing.id}: ${err}`);
          }
        }
      }

      if (Object.keys(updateFields).length === 0) {
        skipped++;
        continue;
      }

      logger.info(`[${i + 1}/${listings.length}] ${headline.slice(0, 50)} — filling ${Object.keys(updateFields).length} fields`, {
        fields: Object.keys(updateFields).filter(k => !k.includes("_en") && !k.includes("_de")),
      });

      if (!opts.dryRun) {
        const { error: updateError } = await supabase
          .from("aircraft_listings")
          .update({ ...updateFields, updated_at: new Date().toISOString() })
          .eq("id", listing.id);

        if (updateError) {
          logger.error(`Failed to update ${listing.id}: ${updateError.message}`);
          failed++;
          continue;
        }
      }

      updated++;

      // Rate limiting: small delay between API calls
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.error(`Error processing ${listing.id}: ${err}`);
      failed++;
    }
  }

  const extractTokens = getExtractionTokenUsage();
  const translateTokens = getTranslationTokenUsage();

  logger.info("Backfill complete", {
    total: listings.length,
    updated,
    skipped,
    failed,
    dryRun: opts.dryRun,
    extractionTokens: extractTokens,
    translationTokens: translateTokens,
  });
}

main().catch((err) => {
  logger.error("Backfill failed", { error: err });
  process.exit(1);
});
