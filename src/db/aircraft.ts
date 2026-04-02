import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug } from "../utils/slug.js";
import { LANGS, buildLocaleFields } from "./locale-helpers.js";
import { lookupReferenceSpecs, applyReferenceSpecs } from "./reference-specs.js";
import type { ParsedAircraftListing } from "../types.js";

/**
 * Known manufacturer names → their aircraft_manufacturers.id in the DB.
 * Looked up dynamically on first call and cached.
 */
let manufacturerCache: Map<string, number> | null = null;

/**
 * Well-known UL/LSA/GA manufacturer names for fuzzy title matching.
 * These are checked against listing titles to identify the manufacturer
 * even if they're not yet in the DB (they'll be auto-created).
 */
const KNOWN_MANUFACTURERS = [
  // UL / LSA / Microlight
  "Dynamic", "Aerospool", "Comco Ikarus", "Ikarus", "Flight Design", "Pipistrel",
  "Tecnam", "Zlin Savage", "Savage", "AutoGyro", "Aeropilot", "Evektor",
  "Remos", "Pioneer", "FK Lightplanes", "FK", "Roland", "ICP", "Aeropro",
  "Eurofox", "FlySynthesis", "TL Ultralight", "DynAero", "Zenair", "Aeroprakt",
  "BRM Aero", "Bristell", "Vampire", "Fresh Breeze", "Rans", "Air Creation",
  "Magni", "Celier", "Blackshape", "Tomark", "Shark Aero", "Atec", "Ekolot",
  "Czech Sport Aircraft", "Sling", "Jabiru", "Corvus", "Alpi Aviation",
  "SD Planes", "Breezer", "JMB", "Just Aircraft", "Kitfox", "Skyranger",
  "Scheibe", "Stemme", "DG Flugzeugbau",
  // SEP / MEP
  "Cessna", "Piper", "Beechcraft", "Cirrus", "Diamond", "Mooney", "Robin",
  "Grumman", "Socata", "Daher", "Extra", "Maule", "Aviat", "CubCrafters",
  "Bellanca", "Lake", "Commander", "Fuji", "Jodel", "Grob", "Zlin",
  // Turboprop
  "Pilatus", "Quest", "Piaggio", "Dornier", "ATR",
  // Jet
  "Eclipse", "HondaJet", "Embraer", "Bombardier", "Gulfstream", "Dassault",
  "Learjet", "Hawker",
  // Helicopter
  "Robinson", "Airbus Helicopters", "Bell", "Leonardo", "MD Helicopters",
  "Sikorsky", "Enstrom", "Guimbal", "Schweizer",
  // Experimental / Aerobatic
  "Vans", "Van's", "Lancair", "Glasair", "Murphy", "Sonex", "Pitts",
  "XtremeAir", "Cap Aviation", "Yakovlev", "Sukhoi",
  // Trike / Paramotor
  "P&M Aviation", "Cosmos", "Airborne",
  // Historic / Warbird
  "North American", "De Havilland", "Stinson", "Luscombe", "Aeronca", "Taylorcraft",
  // German UL specific
  "Heller", "Eurostar", "Fascination", "Drachen", "Storch",
  "Ikarus", "Comco", "Dallach", "Rotorsport", "RotorSchmiede",
  "ELA", "Trendak", "ArrowCopter",
];

/** Unique manufacturer names from reference_specs table (cached) */
let refSpecManufacturers: string[] | null = null;

async function loadRefSpecManufacturers(): Promise<string[]> {
  if (refSpecManufacturers) return refSpecManufacturers;
  const { data } = await supabase
    .from("aircraft_reference_specs")
    .select("manufacturer");
  const unique = [...new Set((data ?? []).map((r) => r.manufacturer as string))];
  // Sort longest first for better matching
  refSpecManufacturers = unique.sort((a, b) => b.length - a.length);
  return refSpecManufacturers;
}

async function getManufacturerMap(): Promise<Map<string, number>> {
  if (manufacturerCache) return manufacturerCache;
  const { data } = await supabase.from("aircraft_manufacturers").select("id, name");
  manufacturerCache = new Map((data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  return manufacturerCache;
}

/**
 * Resolve manufacturer from listing title.
 * 1. Check DB for existing manufacturer match
 * 2. Check KNOWN_MANUFACTURERS list for fuzzy match
 * 3. If found but not in DB → auto-create in aircraft_manufacturers
 * 4. Fallback: extract first significant word and auto-create
 */
type ManufacturerMatch = { id: number; name: string; confidence: "high" | "medium" | "low" };

async function resolveManufacturer(title: string): Promise<ManufacturerMatch> {
  const mfgMap = await getManufacturerMap();
  const titleLower = title.replace(/^(?:update\s+)?\d{2}\.\d{2}\.\d{4}\s*/i, "").toLowerCase().trim();

  // 1. Check existing DB manufacturers → HIGH confidence
  for (const [nameLower, id] of mfgMap.entries()) {
    if (titleLower.includes(nameLower)) {
      const properName = [...mfgMap.entries()].find(([k]) => k === nameLower)?.[0] ?? nameLower;
      return { id, name: properName, confidence: "high" };
    }
  }

  // 2. Check reference specs table → HIGH confidence
  const refSpecsCache = await loadRefSpecManufacturers();
  for (const refMfg of refSpecsCache) {
    if (titleLower.includes(refMfg.toLowerCase())) {
      const id = await createManufacturer(refMfg);
      return { id, name: refMfg, confidence: "high" };
    }
  }

  // 3. Check KNOWN_MANUFACTURERS list → MEDIUM confidence
  const sorted = [...KNOWN_MANUFACTURERS].sort((a, b) => b.length - a.length);
  for (const knownName of sorted) {
    if (titleLower.includes(knownName.toLowerCase())) {
      const id = await createManufacturer(knownName);
      return { id, name: knownName, confidence: "medium" };
    }
  }

  // 4. Fallback: extract from title → LOW confidence (needs admin review)
  const words = titleLower.split(/\s+/);
  const skipWords = ["update", "verkaufe", "zu", "verkaufen", "wegen", "abzugeben", "neu", "neuer", "neue", "verkauf", "top", "sehr", "schöne", "schöner"];
  const firstWord = words.find((w) => w.length > 2 && !/^\d+$/.test(w) && !skipWords.includes(w));

  if (firstWord) {
    const name = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
    const id = await createManufacturer(name);
    logger.warn("Low-confidence manufacturer extraction — listing saved as draft", { title: title.slice(0, 80), manufacturer: name });
    return { id, name, confidence: "low" };
  }

  const id = await createManufacturer("Other");
  logger.warn("Could not resolve manufacturer — listing saved as draft", { title: title.slice(0, 80) });
  return { id, name: "Other", confidence: "low" };
}

/**
 * Create a new manufacturer in aircraft_manufacturers and update cache.
 */
async function createManufacturer(name: string): Promise<number> {
  // Check cache again (might have been created by a previous listing in this run)
  const mfgMap = await getManufacturerMap();
  const existing = mfgMap.get(name.toLowerCase());
  if (existing) return existing;

  const { data, error } = await supabase
    .from("aircraft_manufacturers")
    .insert({ name })
    .select("id")
    .single();

  if (error) {
    // Might be a unique constraint conflict (race condition) — try to fetch
    const { data: found } = await supabase
      .from("aircraft_manufacturers")
      .select("id")
      .eq("name", name)
      .single();
    if (found) {
      mfgMap.set(name.toLowerCase(), found.id);
      return found.id;
    }
    logger.warn("Failed to create manufacturer", { name, error: error.message });
    return 0; // Will show as "Unknown" but at least won't crash
  }

  // Update cache
  mfgMap.set(name.toLowerCase(), data.id);
  logger.info("Created new manufacturer", { name, id: data.id });
  return data.id;
}

/**
 * Extract a clean model name from the title.
 * Goal: "21.11.2025 Dynamic WT-9 mit Rotax 915..." → "WT-9"
 */
function extractModel(title: string, manufacturerName: string): string {
  // Remove date prefix like "21.11.2025 " or "Update 22.06.2025 "
  let cleaned = title
    .replace(/^(?:update\s+)?\d{2}\.\d{2}\.\d{4}\s*/i, "")
    .trim();

  // Remove manufacturer name to isolate model
  const mfgIdx = cleaned.toLowerCase().indexOf(manufacturerName.toLowerCase());
  if (mfgIdx >= 0) {
    cleaned = cleaned.slice(mfgIdx + manufacturerName.length).trim();
  }

  // Take model part: up to first natural break
  // "WT-9 mit Rotax 915 SFG..." → "WT-9"
  // "C42 B Fluglehrer..." → "C42 B"
  // "172 Skyhawk SP..." → "172 Skyhawk SP"
  const breakWords = /\b(?:mit|with|zu|zum|wegen|auf|und|bei|für|von|ist|wird|Baujahr|Rotax|Motor|Betrieb|Flugstunden|verkaufe?n?|abzugeben|sell|for sale|TT|TTSN|MTOW)\b/i;
  const parts = cleaned.split(breakWords);
  let modelPart = (parts[0] ?? cleaned).trim();

  // Clean up trailing punctuation and whitespace
  modelPart = modelPart.replace(/[,;:\-–—]+$/, "").trim();

  // Limit length
  if (modelPart.length > 50) {
    modelPart = modelPart.slice(0, 50).replace(/\s+\S*$/, "").trim();
  }

  return modelPart || cleaned.slice(0, 50);
}

/**
 * Detect aircraft category based on engine type, manufacturer, and content.
 *
 * Category IDs from aircraft_categories table:
 *  1=Single Engine Piston, 2=Multi Engine Piston, 9=Turboprop,
 * 10=Helicopter, 11=Light Sport Aircraft, 12=Commercial Airliner, 13=Other
 *
 * Key rule: Rotax engines → Light Sport Aircraft (11)
 *          Lycoming/Continental engines → Single Engine Piston (1)
 */
function detectCategoryId(title: string, description: string, engine: string | null, manufacturer: string): number {
  const text = `${title} ${description} ${engine ?? ""}`.toLowerCase();
  const mfg = manufacturer.toLowerCase();

  // Helicopter / Gyrocopter
  if (/gyrocopter|tragschrauber|autogyro/i.test(text)) return 10;
  if (/hubschrauber|helicopter|heli\b/i.test(text)) return 10;
  if (["robinson", "airbus helicopters", "bell", "leonardo", "md helicopters", "sikorsky", "enstrom", "guimbal", "schweizer"].includes(mfg)) return 10;
  if (["autogyro", "magni", "celier", "ela aviacion", "trendak", "rotorschmiede", "arrowcopter"].includes(mfg)) return 10;

  // Gliders / Motorgliders → 14
  if (/motorsegler|segelflug|glider|touring motor glider|tmg/i.test(text)) return 14;
  if (["stemme", "schempp-hirth", "dg flugzeugbau"].includes(mfg)) return 14;
  if (mfg === "scheibe") return 14;

  // Paramotors, trikes, flex-wing → 15 (Microlight / Flex-Wing)
  if (/motorschirm|paramotor|gleitschirm|paraglider|trike\b|drachen|flex.?wing/i.test(text)) return 15;
  if (["fresh breeze", "air creation", "cosmos", "airborne", "p&m aviation"].includes(mfg)) return 15;

  // Jets
  if (/\bjet\b|citation|phenom|learjet|gulfstream|bombardier|challenger|falcon\b|global\s*\d/i.test(text)) {
    if (/very light jet|vlj|sf50|eclipse|mustang/i.test(text)) return 3; // Very Light Jet
    if (/light jet|cj[1-4]|phenom 100|hondajet|pc-24/i.test(text)) return 4; // Light Jet
    if (/mid.?size|xls|latitude|hawker/i.test(text)) return 5; // Mid-Size Jet
    if (/super mid|longitude|challenger|praetor/i.test(text)) return 6; // Super Mid-Size Jet
    if (/heavy|g[5-7]\d\d|global|falcon [6-8]/i.test(text)) return 7; // Heavy Jet
    if (/ultra.?long|g700|global 7/i.test(text)) return 8; // Ultra Long Range
    return 4; // Default jet → Light Jet
  }
  if (["cirrus", "eclipse", "hondajet", "embraer", "bombardier", "gulfstream", "dassault", "learjet", "hawker"].includes(mfg)) {
    if (mfg === "cirrus" && /sr2[02]/i.test(text)) return 1; // Cirrus SR20/SR22 = Single Engine Piston
    return 4; // Default for jet manufacturers
  }

  // Turboprop
  if (/turboprop|pt6|king air|tbm|pc-12|pc-6|caravan|kodiak|piaggio|dornier|atr/i.test(text)) return 9;
  if (["daher", "pilatus", "quest", "piaggio", "dornier", "atr", "epic"].includes(mfg)) return 9;

  // Multi Engine Piston
  if (/twin|multi.?engine|seneca|seminole|baron|duchess|navajo|aztec|pa-3[014]|pa-44|cessna 3[0-4]\d|cessna 4[0-2]\d|da42|p68/i.test(text)) return 2;

  // Engine-based detection (most reliable for piston aircraft)
  if (/rotax|jabiru|ulpower|hks|simonini|polini|vittorazi|cors.?air|hirth/i.test(text)) return 11; // Light Sport Aircraft (UL engines)
  if (/lycoming|continental|io-\d{3}|o-\d{3}|tio-|tsio-/i.test(text)) return 1; // Single Engine Piston (GA engines)

  // Manufacturer-based fallback
  const sepManufacturers = ["cessna", "piper", "beechcraft", "mooney", "grumman", "socata",
    "robin", "jodel", "grob", "zlin", "fuji", "commander", "lake", "bellanca",
    "stinson", "luscombe", "aeronca", "taylorcraft", "globe", "ercoupe",
    "maule", "aviat", "american champion", "cubcrafters", "extra"];
  const lsaManufacturers = ["dynamic", "aerospool", "comco ikarus", "comco", "ikarus",
    "flight design", "pipistrel", "tecnam", "evektor", "remos", "pioneer",
    "fk lightplanes", "fk", "roland", "icp", "aeropro", "flysynthesis",
    "tl ultralight", "dynaero", "zenair", "aeroprakt", "brm aero", "bristell",
    "jabiru", "corvus", "alpi aviation", "atec", "shark aero", "tomark",
    "blackshape", "czech sport aircraft", "sling", "breezer", "jmb",
    "just aircraft", "kitfox", "rans", "sonex", "scheibe", "stemme",
    "heller", "vampire", "sd planes", "aeropilot"];
  const experimentalManufacturers = ["vans", "van's", "lancair", "glasair", "murphy",
    "pitts", "xtremair", "sukhoi", "yakovlev", "cap aviation", "mudry", "nanchang"];

  if (sepManufacturers.includes(mfg)) return 1; // Single Engine Piston
  if (lsaManufacturers.includes(mfg)) return 11; // Light Sport Aircraft
  if (experimentalManufacturers.includes(mfg)) return 13; // Other (Experimental)

  // Diamond: depends on model
  if (mfg === "diamond") {
    if (/da42|da62/i.test(text)) return 2; // Multi Engine
    if (/hk36|dimona/i.test(text)) return 14; // Glider / motorglider
    return 1; // DA20, DA40, DA50 = Single Engine Piston
  }

  // Default for unknown: Light Sport Aircraft (Helmut's site is UL-focused)
  return 11;
}

/**
 * Extract engine power from engine description.
 * E.g., "Rotax 912ULS 100 PS" → { power: "100", unit: "PS", type: "Rotax 912ULS" }
 */
function parseEnginePower(engine: string | null): {
  power: string | null;
  unit: string | null;
  type: string | null;
} {
  if (!engine) return { power: null, unit: null, type: null };

  const powerMatch = engine.match(/(\d+)\s*(PS|HP|kW)/i);
  const power = powerMatch ? powerMatch[1] : null;
  const unit = powerMatch ? powerMatch[2].toUpperCase() : null;

  // Engine type is everything before the power number
  const typeMatch = engine.match(/^(.+?)(?:\s+\d+\s*(?:PS|HP|kW))/i);
  const type = typeMatch ? typeMatch[1].trim() : engine.trim();

  return { power, unit, type };
}

/**
 * Detect seat count from description/title.
 */
function detectSeats(title: string, description: string): string | null {
  const text = `${title} ${description}`;
  const match = text.match(/(\d)\s*(?:Sitz|Sitzer|seats?|Plätze|sitzig)/i);
  if (match) return match[1];

  // Default for ULs / Microlights: 2 seats
  return "2";
}

/**
 * Upsert a parsed aircraft listing into the Supabase `aircraft_listings` table.
 */
export async function upsertAircraftListing(
  listing: ParsedAircraftListing,
  systemUserId: string
): Promise<"inserted" | "updated" | "skipped"> {
  if (!listing.year || listing.year < 1900 || listing.year > new Date().getFullYear() + 1) {
    logger.debug("Skipping listing: no valid year", { sourceId: listing.sourceId, year: listing.year });
    return "skipped";
  }

  // Fix: ensure description is never empty (description_check constraint)
  // Sanitize first, then check — some descriptions contain only HTML/whitespace
  listing.description = (listing.description ?? "").replace(/<[^>]*>/g, "").trim();
  if (listing.description.length < 3) {
    listing.description = listing.title;
  }
  // Final guard: if even title is too short, skip
  if (!listing.description || listing.description.trim().length < 3) {
    logger.debug("Skipping listing: no valid description or title", { sourceId: listing.sourceId });
    return "skipped";
  }

  const { data: existing, error: lookupError } = await supabase
    .from("aircraft_listings")
    .select("id, updated_at, images")
    .eq("source_url", listing.sourceId)
    .maybeSingle();

  if (lookupError) {
    logger.error("Dedup lookup failed", { sourceId: listing.sourceId, error: lookupError.message });
    return "skipped";
  }

  // Resolve manufacturer (needed for both paths)
  const manufacturer = await resolveManufacturer(listing.title);

  if (existing) {
    // ── UPDATE PATH (fast: skip translation, re-upload external images) ──

    // Re-upload images if they're still pointing to external URLs
    const existingImages = (existing.images as Array<{ url?: string }>) ?? [];
    const hasExternalImages = existingImages.length > 0 && existingImages.some(
      (img) => img.url && !img.url.includes("supabase.co")
    );
    let freshImages: Array<{ url: string; alt_text: string }> = [];
    if (hasExternalImages && listing.imageUrls.length > 0) {
      freshImages = await uploadImages(listing.imageUrls, listing.title);
      if (freshImages.length > 0) {
        logger.debug("Re-uploaded external images", { sourceId: listing.sourceId, count: freshImages.length });
      }
    }

    // Build record WITHOUT translation (keep existing translations)
    const record = await mapToAircraftRow(listing, systemUserId, freshImages, null, manufacturer);

    // Enrich with reference specs
    let enriched = record as Record<string, unknown>;
    const refSpecs = await lookupReferenceSpecs(listing.title, listing.description, listing.engine);
    if (refSpecs) enriched = applyReferenceSpecs(enriched, refSpecs);

    // Strip locale fields from update to preserve existing translations
    const updateFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(enriched)) {
      if (/^(headline|description|slug)_(en|de|fr|es|it|pl|cs|sv|nl|pt|ru|tr|el|no)$/.test(key)) continue;
      if (key === "slug") continue; // Keep DB-generated slug
      if (key === "images" && freshImages.length === 0) continue;
      updateFields[key] = value;
    }

    const { error } = await supabase
      .from("aircraft_listings")
      .update({ ...updateFields, updated_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (error) {
      logger.error("Failed to update aircraft listing", { sourceId: listing.sourceId, error: error.message });
      return "skipped";
    }
    logger.debug("Updated aircraft listing", { sourceId: listing.sourceId });
    return "updated";
  }

  // ── INSERT PATH (full pipeline: images + translation + enrichment) ──
  const images = await uploadImages(listing.imageUrls, listing.title);
  const translations = await translateListing(listing.title, listing.description, "de");

  let record = await mapToAircraftRow(listing, systemUserId, images, translations, manufacturer);

  const refSpecs = await lookupReferenceSpecs(listing.title, listing.description, listing.engine);
  if (refSpecs) {
    record = applyReferenceSpecs(record, refSpecs) as typeof record;
  }

  // Remove slug fields — let DB trigger generate slug + listing_number on INSERT
  const { slug: _slug, ...insertRecord } = record;
  // Also remove slug_XX fields — we'll regenerate after we get listing_number
  const cleanInsert: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(insertRecord)) {
    if (/^slug_(en|de|fr|es|it|pl|cs|sv|nl|pt|ru|tr|el|no)$/.test(key)) continue;
    cleanInsert[key] = value;
  }

  const { data: inserted, error } = await supabase
    .from("aircraft_listings")
    .insert(cleanInsert)
    .select("id, slug, listing_number")
    .single();

  if (error) {
    logger.error("Failed to insert aircraft listing", { sourceId: listing.sourceId, error: error.message });
    return "skipped";
  }

  // Generate proper localized slugs using the DB-assigned listing_number
  const listingNum = inserted.listing_number as number | null;
  if (listingNum && translations) {
    const slugUpdate: Record<string, string> = {};
    if (inserted.slug) slugUpdate.slug_en = inserted.slug;

    for (const lang of LANGS) {
      if (lang === "en") continue;
      const headline = (record as Record<string, unknown>)[`headline_${lang}`];
      if (headline && typeof headline === "string" && headline.trim()) {
        slugUpdate[`slug_${lang}`] = generateSlug(headline, listingNum);
      }
    }

    if (Object.keys(slugUpdate).length > 0) {
      await supabase.from("aircraft_listings").update(slugUpdate).eq("id", inserted.id);
    }
  }

  logger.debug("Inserted aircraft listing", { sourceId: listing.sourceId, listingNumber: listingNum });

  // Log draft listings for admin review
  if (manufacturer.confidence === "low") {
    await logDraftForReview(listing.title, listing.sourceId, manufacturer.name);
  }

  return "inserted";
}

/**
 * Strip date prefix from title for use as headline and slug.
 * "17.02.2025 Ultralight Glider AL12..." → "Ultralight Glider AL12..."
 * "Update 22.06.2025 Pioneer 300..." → "Pioneer 300..."
 */
function stripDatePrefix(title: string): string {
  return title
    .replace(/^(?:update\s+)?\d{2}\.\d{2}\.\d{4}\s*/i, "")
    .trim();
}

async function mapToAircraftRow(
  listing: ParsedAircraftListing,
  systemUserId: string,
  uploadedImages: Array<{ url: string; alt_text: string }>,
  translations: TranslationResult | null,
  manufacturer: ManufacturerMatch
) {
  // Clean headline: strip date prefix for display and slug
  const cleanHeadline = stripDatePrefix(listing.title);
  const localeFields = buildLocaleFields(cleanHeadline, listing.description, translations);
  const engineInfo = parseEnginePower(listing.engine);
  const model = extractModel(listing.title, manufacturer.name);
  const categoryId = detectCategoryId(listing.title, listing.description, listing.engine, manufacturer.name);
  const seats = detectSeats(listing.title, listing.description);
  const originalUrl = listing.sourceUrl;

  // Price logic: null = price on request, 0 = also treated as null
  const hasValidPrice = listing.price !== null && listing.price > 0;

  return {
    headline: cleanHeadline,
    model,
    year: listing.year!,
    registration: "N/A",
    serial_number: "N/A",
    location: listing.location ?? "Germany",
    price: hasValidPrice ? listing.price : null,
    currency: config.defaultCurrency,
    price_negotiable: hasValidPrice ? listing.priceNegotiable : false,
    description: listing.description,

    // Seller info — show source name and link to original
    contact_name: `Helmuts UL Seiten`,
    contact_email: listing.contactEmail ?? "noreply@trade.aero",
    contact_phone: listing.contactPhone ?? "",
    website: originalUrl, // Link to original listing page
    company: listing.sourceName,
    agree_to_terms: true,

    // Category (aircraft type)
    category_id: categoryId,
    condition_id: listing.year && listing.year >= new Date().getFullYear() - 2 ? 1 : 3, // Excellent if <=2yr, else Good

    // Manufacturer (FK if matched, name always set)
    manufacturer_id: manufacturer.id,

    // Engine
    engine_type_name: engineInfo.type,
    engine_power: engineInfo.power,
    engine_power_unit: engineInfo.unit ?? "PS",

    // Seats
    seats,

    // Fuel type: Rotax engines always use MOGAS
    fuel_type: listing.engine?.toLowerCase().includes("rotax") ? "MOGAS" : null,

    // All 14 locale columns
    ...localeFields,

    slug: generateSlug(cleanHeadline),

    // Ownership & origin
    user_id: systemUserId,
    source_name: listing.sourceName,
    source_url: listing.sourceId,
    is_external: true,

    // Status: draft if no images, unknown manufacturer, or no valid price
    status: (uploadedImages.length === 0 || manufacturer.confidence === "low") ? "draft" : "active",
    country: "Germany",

    // Specs
    total_time: listing.totalTime && listing.totalTime > 0 ? listing.totalTime : null,
    max_takeoff_weight: listing.mtow?.toString() ?? null,
    max_takeoff_weight_unit: listing.mtow ? "kg" : null,
    last_annual_inspection: isValidIsoDate(listing.annualInspection) ? listing.annualInspection : null,

    // Images — enriched with per-locale alt text from translations
    images: enrichImagesWithLocalizedAlt(uploadedImages, listing.title, translations),

    auto_translate: false,
    headline_auto_translate: false,
  };
}

/**
 * Enrich images with per-locale alt_text_{lang} fields matching ImageWithMeta format.
 * Uses translated headlines as alt text per locale.
 */
function enrichImagesWithLocalizedAlt(
  images: Array<{ url: string; alt_text: string }>,
  defaultAlt: string,
  translations: TranslationResult | null
): Array<Record<string, unknown>> {
  return images.map((img, idx) => {
    const enriched: Record<string, unknown> = {
      url: img.url,
      alt_text: img.alt_text || defaultAlt,
      auto_translate: false,
      sort_order: idx,
    };
    // Add per-locale alt text from translations
    for (const lang of LANGS) {
      const t = translations?.[lang];
      enriched[`alt_text_${lang}`] = t?.headline
        ? `${t.headline} - Image ${idx + 1}`
        : `${defaultAlt} - Image ${idx + 1}`;
    }
    return enriched;
  });
}


function isValidIsoDate(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}

/**
 * Log a draft listing to admin_activity_logs for review.
 * Admin dashboard shows these under the Activity tab.
 */
async function logDraftForReview(title: string, sourceId: string, guessedManufacturer: string): Promise<void> {
  try {
    await supabase.from("admin_activity_logs").insert({
      action: "Crawler: listing saved as draft — unknown manufacturer",
      target_type: "listing",
      target_name: title.slice(0, 200),
      metadata: {
        source_id: sourceId,
        guessed_manufacturer: guessedManufacturer,
        reason: "Manufacturer not found in DB, reference specs, or known list. Needs manual review.",
      },
    });
  } catch {
    // Non-critical — don't fail the crawl for logging issues
  }
}
