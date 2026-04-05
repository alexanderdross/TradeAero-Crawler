import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { generateSlug } from "../utils/slug.js";
import { LANGS, buildLocaleFields } from "./locale-helpers.js";
import { lookupReferenceSpecs, applyReferenceSpecs } from "./reference-specs.js";
import type { ParsedAircraftListing } from "../types.js";
import { stripTitleDatePrefix } from "../parsers/shared.js";

/**
 * Known manufacturer names → their aircraft_manufacturers.id in the DB.
 * Looked up dynamically on first call and cached.
 */
let manufacturerCache: Map<string, number> | null = null;

/**
 * Unique manufacturer names from aircraft_reference_specs table (cached).
 * This is the single source of truth for valid manufacturer names.
 * No more hardcoded KNOWN_MANUFACTURERS list — reference specs has 610+ models.
 */
let refSpecManufacturers: string[] | null = null;

async function loadRefSpecManufacturers(): Promise<string[]> {
  if (refSpecManufacturers) return refSpecManufacturers;
  const { data } = await (supabase as any)
    .from("aircraft_reference_specs")
    .select("manufacturer");
  const raw: string[] = (data ?? []).map((r: any) => r.manufacturer as string).filter(Boolean);
  const unique = [...new Set(raw)];
  // Sort longest first for better matching (e.g. "Comco Ikarus" before "Ikarus")
  refSpecManufacturers = unique.sort((a: string, b: string) => b.length - a.length);
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
 * Single source of truth: aircraft_reference_specs table (610+ models).
 *
 * 1. Check DB manufacturers table (already validated names)
 * 2. Check reference specs table (clean manufacturer names from curated data)
 * 3. Fallback → "Other" with LOW confidence (listing saved as draft)
 *
 * Never auto-creates junk manufacturers from title words.
 */
type ManufacturerMatch = { id: number; name: string; confidence: "high" | "medium" | "low" };

async function resolveManufacturer(title: string, hint?: string): Promise<ManufacturerMatch> {
  const mfgMap = await getManufacturerMap();
  const titleLower = title.replace(/^(?:update\s+)?\d{2}\.\d{2}\.\d{4}\s*/i, "").toLowerCase().trim();

  // Build a combined search string: hint (from URL) + title
  // The hint is more reliable (no garbled price/spec text mixed in)
  const hintLower = hint ? hint.toLowerCase().trim() : "";
  const searchText = hintLower ? `${hintLower} ${titleLower}` : titleLower;

  // 1. Check existing DB manufacturers → HIGH confidence
  // Sort by name length descending to match "Comco Ikarus" before "Ikarus"
  const dbEntries = [...mfgMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [nameLower, id] of dbEntries) {
    if (nameLower.length >= 3 && searchText.includes(nameLower)) {
      const properName = [...mfgMap.entries()].find(([k]) => k === nameLower)?.[0] ?? nameLower;
      return { id, name: properName, confidence: "high" };
    }
  }

  // 2. Check reference specs table → HIGH confidence
  // Also try matching just the first word of multi-word manufacturer names
  // e.g. reference has "Diamond Aircraft" but title just says "Diamond DA40NG"
  const refSpecsCache = await loadRefSpecManufacturers();
  for (const refMfg of refSpecsCache) {
    if (refMfg.length < 3) continue;
    const refLower = refMfg.toLowerCase();
    // Full name match
    if (searchText.includes(refLower)) {
      const id = await createManufacturer(refMfg);
      return { id, name: refMfg, confidence: "high" };
    }
    // First-word match for multi-word names (e.g. "Diamond Aircraft" → "diamond")
    const firstWord = refLower.split(/\s+/)[0];
    if (firstWord.length >= 4 && searchText.includes(firstWord)) {
      const id = await createManufacturer(refMfg);
      return { id, name: refMfg, confidence: "high" };
    }
  }

  // 3. If hint is present, use it as manufacturer name directly (URL slug is reliable)
  if (hintLower.length >= 3) {
    // Capitalise the hint properly (e.g. "diamond" → "Diamond", "czech aircraft works" → "Czech Aircraft Works")
    const properHint = hint!.replace(/\b\w/g, (c) => c.toUpperCase());
    const id = await createManufacturer(properHint);
    logger.info("Resolved manufacturer from URL hint", { hint: properHint, title: title.slice(0, 60) });
    return { id, name: properHint, confidence: "medium" };
  }

  // 4. No match → "Other" (listing saved as draft for admin review)
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
  let cleaned = stripTitleDatePrefix(title);

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

  // Remove aircraft registration/call signs (D-MSEW, HB-YGX, OE-ABC, N12345, etc.)
  modelPart = modelPart.replace(/\b[A-Z]{1,2}-[A-Z]{2,5}\b/g, "").trim();
  modelPart = modelPart.replace(/\bN\d{1,5}[A-Z]{0,2}\b/g, "").trim(); // US N-numbers

  // Clean up trailing punctuation and whitespace
  modelPart = modelPart.replace(/[,;:\-–—]+$/, "").trim();

  // Reject pure numbers (e.g. "47", "120") — these are listing numbers, not model names
  if (/^\d+$/.test(modelPart)) {
    modelPart = "";
  }

  // Limit length
  if (modelPart.length > 50) {
    modelPart = modelPart.slice(0, 50).replace(/\s+\S*$/, "").trim();
  }

  return modelPart || cleaned.slice(0, 50);
}

/**
 * Category name cache: maps category name → DB id.
 * Populated on first call to resolveCategoryId().
 */
let categoryCache: Map<string, number> | null = null;

/**
 * Resolve a category name to its DB id.
 * Queries the DB once and caches the mapping.
 */
async function resolveCategoryId(categoryName: string): Promise<number> {
  if (!categoryCache) {
    categoryCache = new Map();
    const { data: categories } = await supabase
      .from("aircraft_categories")
      .select("id, name");
    if (categories) {
      for (const cat of categories) {
        categoryCache.set(cat.name.toLowerCase(), cat.id);
      }
    }
    logger.debug("Loaded category cache", { count: categoryCache.size });
  }

  const id = categoryCache.get(categoryName.toLowerCase());
  if (id !== undefined) return id;

  // Fallback: try to create the category
  const { data, error } = await supabase
    .from("aircraft_categories")
    .insert({ name: categoryName })
    .select("id")
    .single();

  if (data) {
    categoryCache.set(categoryName.toLowerCase(), data.id);
    logger.info("Created new category", { name: categoryName, id: data.id });
    return data.id;
  }

  // If creation fails (e.g., already exists), try to look it up again
  if (error) {
    const { data: existing } = await supabase
      .from("aircraft_categories")
      .select("id")
      .eq("name", categoryName)
      .single();
    if (existing) {
      categoryCache.set(categoryName.toLowerCase(), existing.id);
      return existing.id;
    }
  }

  logger.warn("Could not resolve category", { name: categoryName });
  return 0;
}

/**
 * Detect aircraft category name based on engine type, manufacturer, and content.
 *
 * Key rule: Rotax engines → Ultralight / Light Sport Aircraft (LSA)
 *          Lycoming/Continental engines → Single Engine Piston
 */
function detectCategoryName(title: string, description: string, engine: string | null, manufacturer: string): string {
  const text = `${title} ${description} ${engine ?? ""}`.toLowerCase();
  const mfg = manufacturer.toLowerCase();

  // Helicopter / Gyrocopter
  if (/gyrocopter|tragschrauber|autogyro/i.test(text)) return "Helicopter / Gyrocopter";
  if (/hubschrauber|helicopter|heli\b/i.test(text)) return "Helicopter / Gyrocopter";
  if (["robinson", "airbus helicopters", "bell", "leonardo", "md helicopters", "sikorsky", "enstrom", "guimbal", "schweizer"].includes(mfg)) return "Helicopter / Gyrocopter";
  if (["autogyro", "magni", "celier", "ela aviacion", "trendak", "rotorschmiede", "arrowcopter"].includes(mfg)) return "Helicopter / Gyrocopter";

  // Gliders / Motorgliders
  if (/motorsegler|segelflug|glider|touring motor glider|tmg/i.test(text)) return "Glider";
  if (["stemme", "schempp-hirth", "dg flugzeugbau"].includes(mfg)) return "Glider";
  if (mfg === "scheibe") return "Glider";

  // Paramotors, trikes, flex-wing
  if (/motorschirm|paramotor|gleitschirm|paraglider|trike\b|drachen|flex.?wing/i.test(text)) return "Microlight / Flex-Wing";
  if (["fresh breeze", "air creation", "cosmos", "airborne", "p&m aviation"].includes(mfg)) return "Microlight / Flex-Wing";

  // Jets
  if (/\bjet\b|citation|phenom|learjet|gulfstream|bombardier|challenger|falcon\b|global\s*\d/i.test(text)) {
    if (/very light jet|vlj|sf50|eclipse|mustang/i.test(text)) return "Jet";
    if (/light jet|cj[1-4]|phenom 100|hondajet|pc-24/i.test(text)) return "Jet";
    if (/mid.?size|xls|latitude|hawker/i.test(text)) return "Jet";
    if (/super mid|longitude|challenger|praetor/i.test(text)) return "Jet";
    if (/heavy|g[5-7]\d\d|global|falcon [6-8]/i.test(text)) return "Jet";
    if (/ultra.?long|g700|global 7/i.test(text)) return "Jet";
    return "Jet";
  }
  if (["cirrus", "eclipse", "hondajet", "embraer", "bombardier", "gulfstream", "dassault", "learjet", "hawker"].includes(mfg)) {
    if (mfg === "cirrus" && /sr2[02]/i.test(text)) return "Single Engine Piston";
    return "Jet";
  }

  // Turboprop
  if (/turboprop|pt6|king air|tbm|pc-12|pc-6|caravan|kodiak|piaggio|dornier|atr/i.test(text)) return "Turboprop";
  if (["daher", "pilatus", "quest", "piaggio", "dornier", "atr", "epic"].includes(mfg)) return "Turboprop";

  // Multi Engine Piston
  if (/twin|multi.?engine|seneca|seminole|baron|duchess|navajo|aztec|pa-3[014]|pa-44|cessna 3[0-4]\d|cessna 4[0-2]\d|da42|p68/i.test(text)) return "Multi Engine Piston";

  // Engine-based detection (most reliable for piston aircraft)
  if (/rotax|jabiru|ulpower|hks|simonini|polini|vittorazi|cors.?air|hirth/i.test(text)) return "Ultralight / Light Sport Aircraft (LSA)";
  if (/lycoming|continental|io-\d{3}|o-\d{3}|tio-|tsio-/i.test(text)) return "Single Engine Piston";

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

  if (sepManufacturers.includes(mfg)) return "Single Engine Piston";
  if (lsaManufacturers.includes(mfg)) return "Ultralight / Light Sport Aircraft (LSA)";
  if (experimentalManufacturers.includes(mfg)) return "Experimental / Homebuilt";

  // Diamond: depends on model
  if (mfg === "diamond") {
    if (/da42|da62/i.test(text)) return "Multi Engine Piston";
    if (/hk36|dimona/i.test(text)) return "Glider";
    return "Single Engine Piston";
  }

  // Default for unknown: Light Sport Aircraft (Helmut's site is UL-focused)
  return "Ultralight / Light Sport Aircraft (LSA)";
}

/**
 * Extract engine power from engine description.
 * E.g., "Rotax 912ULS 100 PS" → { power: "100", unit: "PS", type: "Rotax 912ULS" }
 */
/** Known engine model patterns — ordered from most to least specific */
const ENGINE_MODEL_RE = [
  /Rotax\s+\d+[\w.\s-]*/i,
  /Lycoming\s+[A-Z]{1,3}[-\d][\w.\s-]*/i,
  /Continental\s+[A-Z]{1,3}[-\d][\w.\s-]*/i,
  /Jabiru\s+\d+[\w.\s-]*/i,
  /HKS\s+\d+[\w.\s-]*/i,
  /Limbach\s+[LT]\s*\d+[\w.\s-]*/i,
  /Simonini\s+[\w\d.\s-]*/i,
  /Solo\s+\d+[\w.\s-]*/i,
  /BMW\s+[\w\d.\s-]*/i,
  /ULPower\s+[\w\d.\s-]*/i,
  /D-Motor\s+[\w\d.\s-]*/i,
  /Sauer\s+[\w\d.\s-]*/i,
  /Hirth\s+\d+[\w.\s-]*/i,
];

/** Delimiters that indicate the engine field has overflowed into description text */
const ENGINE_OVERFLOW_RE = /\s*(?:Motorstunden|Motorbetriebsstunden|TTSN|TTAF|Zelle|Ausstattung|Baujahr|\bTT\b|\b\d{3,}\s*h\b|,\s*(?:wird|kann|ist\s)|Funk\s|Transponder|Flarm|FLARM)/i;

function parseEnginePower(engine: string | null): {
  power: string | null;
  unit: string | null;
  type: string | null;
} {
  if (!engine) return { power: null, unit: null, type: null };

  const powerMatch = engine.match(/(\d+)\s*(PS|HP|kW)/i);
  const power = powerMatch ? powerMatch[1] : null;
  const unit = powerMatch ? powerMatch[2].toUpperCase() : null;

  // Try to extract a known engine model name first
  for (const re of ENGINE_MODEL_RE) {
    const m = engine.match(re);
    if (m) {
      // Truncate the match at overflow delimiters
      const raw = m[0].replace(ENGINE_OVERFLOW_RE, "").trim();
      const type = raw.slice(0, 60).trim();
      if (type.length >= 3) return { power, unit, type };
    }
  }

  // Fallback: everything before the power number, truncated at overflow delimiters
  const typeMatch = engine.match(/^(.+?)(?:\s+\d+\s*(?:PS|HP|kW))/i);
  let type = typeMatch ? typeMatch[1].trim() : engine.trim();
  type = type.replace(ENGINE_OVERFLOW_RE, "").trim().slice(0, 60);

  return { power, unit, type: type.length >= 3 ? type : null };
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
  if (listing.description.length < 10) {
    listing.description = listing.title;
  }
  if (!listing.description || listing.description.trim().length < 10) {
    const descParts = [listing.title];
    if (listing.year) descParts.push(`Year: ${listing.year}`);
    if (listing.engine) descParts.push(`Engine: ${listing.engine}`);
    if (listing.location) descParts.push(`Location: ${listing.location}`);
    if (listing.totalTime) descParts.push(`Total Time: ${listing.totalTime}h`);
    listing.description = descParts.join(". ");
  }
  if (!listing.description || listing.description.trim().length < 10) {
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

  // Cross-source dedup: check if same aircraft exists from a different source
  // Match by registration (call sign) or serial number — unique per aircraft worldwide
  if (!existing) {
    const fullText = `${listing.title} ${listing.description}`;
    const reg = extractRegistration(fullText);
    const serial = extractSerialNumber(fullText);

    if (reg && reg !== "N/A") {
      const { data: dupByReg } = await supabase
        .from("aircraft_listings")
        .select("id, source_name")
        .eq("registration", reg)
        .neq("source_url", listing.sourceId)
        .maybeSingle();

      if (dupByReg) {
        logger.info("Cross-source duplicate found by registration", {
          registration: reg,
          sourceId: listing.sourceId,
          existingSource: dupByReg.source_name,
          existingId: dupByReg.id,
        });
        return "skipped";
      }
    }

    if (serial && serial !== "N/A") {
      const { data: dupBySerial } = await supabase
        .from("aircraft_listings")
        .select("id, source_name")
        .eq("serial_number", serial)
        .neq("source_url", listing.sourceId)
        .maybeSingle();

      if (dupBySerial) {
        logger.info("Cross-source duplicate found by serial number", {
          serialNumber: serial,
          sourceId: listing.sourceId,
          existingSource: dupBySerial.source_name,
          existingId: dupBySerial.id,
        });
        return "skipped";
      }
    }

    // Fuzzy title dedup: match by first 30 chars of headline + same year + same price
    if (listing.year && listing.price) {
      const titlePrefix = stripTitleDatePrefix(listing.title).substring(0, 30).trim();
      if (titlePrefix.length >= 10) {
        const { data: dupByTitle } = await supabase
          .from("aircraft_listings")
          .select("id, source_name")
          .ilike("headline", `${titlePrefix}%`)
          .eq("year", listing.year)
          .eq("price", listing.price)
          .neq("source_url", listing.sourceId)
          .limit(1)
          .maybeSingle();

        if (dupByTitle) {
          logger.info("Fuzzy duplicate found by title+year+price", {
            titlePrefix,
            sourceId: listing.sourceId,
            existingSource: dupByTitle.source_name,
          });
          return "skipped";
        }
      }
    }
  }

  // Resolve manufacturer (needed for both paths)
  const manufacturer = await resolveManufacturer(listing.title, listing.manufacturerHint);

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
    if (refSpecs) {
      enriched = applyReferenceSpecs(enriched, refSpecs);
      const refModel = (refSpecs as any).ref_model;
      const refVariant = (refSpecs as any).ref_variant;
      if (refModel) {
        enriched.model = refVariant ? `${refModel} ${refVariant}` : refModel;
      }
    }

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
  // Cap at 10 images — matches premium plan limit; avoids gallery bloat from scraped pages
  const MAX_CRAWLED_IMAGES = 10;
  const images = await uploadImages(listing.imageUrls.slice(0, MAX_CRAWLED_IMAGES), listing.title);
  const translations = await translateListing(listing.title, listing.description, "de");

  let record = await mapToAircraftRow(listing, systemUserId, images, translations, manufacturer);

  const refSpecs = await lookupReferenceSpecs(listing.title, listing.description, listing.engine);
  if (refSpecs) {
    record = applyReferenceSpecs(record, refSpecs) as typeof record;
    // Use clean model name from reference specs if available
    const refModel = (refSpecs as any).ref_model;
    const refVariant = (refSpecs as any).ref_variant;
    if (refModel) {
      record.model = refVariant ? `${refModel} ${refVariant}` : refModel;
    }
    // Note: headline is kept as the original crawled text (good for SEO keywords).
    // Frontend displays clean "Manufacturer Model" for UI cards/breadcrumbs.
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
    // Constraint violations (e.g. description_check) are non-fatal — log as warning and skip
    const level = error.message?.includes('check constraint') ? 'warn' : 'error';
    logger[level]("Failed to insert aircraft listing", { sourceId: listing.sourceId, error: error.message });
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

async function mapToAircraftRow(
  listing: ParsedAircraftListing,
  systemUserId: string,
  uploadedImages: Array<{ url: string; alt_text: string }>,
  translations: TranslationResult | null,
  manufacturer: ManufacturerMatch
) {
  // Clean headline: strip date prefix and spec keywords for display and slug
  let cleanHeadline = stripTitleDatePrefix(listing.title);
  // Truncate at spec keywords — headline should be the aircraft name, not full specs
  const headlineBreak = /\b(?:Baujahr|Werk\s*Nr|Betriebsstunden|Leermasse|MTOW|Flugstunden|Kennzeichen|Seriennummer|Motor:|TT:|TTSN|Zustand|verkaufe|abzugeben|zu\s+verkaufen)\b/i;
  const headlineParts = cleanHeadline.split(headlineBreak);
  if (headlineParts[0] && headlineParts[0].trim().length >= 5) {
    cleanHeadline = headlineParts[0].trim().replace(/[,;:\-–—]+$/, "").trim();
  }
  const localeFields = buildLocaleFields(cleanHeadline, listing.description, translations);
  const engineInfo = parseEnginePower(listing.engine);
  const model = extractModel(listing.title, manufacturer.name);
  // Use URL-based category hint (aircraft24) if available — more reliable than keyword detection
  const categoryName = listing.categoryHint
    ?? detectCategoryName(listing.title, listing.description, listing.engine, manufacturer.name);
  const categoryId = await resolveCategoryId(categoryName);
  const seats = detectSeats(listing.title, listing.description);
  const originalUrl = listing.sourceUrl;

  // Price logic: null = price on request, 0 = also treated as null
  const hasValidPrice = listing.price !== null && listing.price > 0;

  // Extract city and airfield from description text if not found in structured fields
  const fullText = `${listing.title} ${listing.description}`;
  const rawCity = listing.city ?? extractCityFromText(fullText);
  const city = sanitizeCity(rawCity);
  const airfield = listing.airfieldName ?? extractAirfieldFromText(fullText);
  const icao = listing.icaoCode ?? extractIcaoFromText(fullText);

  // Contact: use parsed fields, falling back to description text extraction
  const contactEmail = listing.contactEmail ?? extractEmailFromText(listing.description);
  const contactPhone = listing.contactPhone ?? extractPhoneFromText(listing.description);

  // Extract registration and serial number from title + description
  const listingFullText = `${listing.title} ${listing.description}`;
  const registration = listing.registration ?? extractRegistration(listingFullText) ?? "N/A";
  const serialNumber = listing.serialNumber ?? extractSerialNumber(listingFullText) ?? "N/A";

  // Detect equipment feature IDs from listing text
  const featureIds = await detectFeatureIds(listingFullText);

  return {
    headline: cleanHeadline,
    model,
    year: listing.year!,
    registration,
    serial_number: serialNumber,
    location: sanitizeCity(listing.location) ?? city ?? "Germany",
    city: city ?? null,
    state: resolveGermanState(city),
    country: listing.country ?? "Germany",
    price: hasValidPrice ? listing.price : null,
    currency: config.defaultCurrency,
    price_negotiable: listing.priceNegotiable ?? false,
    description: listing.description,

    // Seller info — show source name and link to original
    contact_name: `Helmuts UL Seiten`,
    contact_email: contactEmail ?? "noreply@trade.aero",
    contact_phone: contactPhone ?? "",
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

    // All 14 locale columns
    ...localeFields,

    slug: generateSlug(cleanHeadline),

    // Ownership & origin
    user_id: systemUserId,
    source_name: listing.sourceName,
    source_url: listing.sourceId,
    is_external: true,

    // Airfield / homebase
    homebase: airfield ?? null,
    icaocode: icao ?? null,

    // Status: draft if no images, unknown manufacturer, or no valid price
    status: (uploadedImages.length === 0 || manufacturer.confidence === "low") ? "draft" : "active",

    // Specs
    total_time: listing.totalTime && listing.totalTime > 0 ? listing.totalTime : null,
    engine_hours: listing.engineHours && listing.engineHours > 0 ? listing.engineHours : null,
    cycles: listing.cycles && listing.cycles > 0 ? listing.cycles : null,
    max_takeoff_weight: listing.mtow?.toString() ?? listing.maxTakeoffWeight?.toString() ?? null,
    max_takeoff_weight_unit: (listing.mtow || listing.maxTakeoffWeight) ? "kg" : null,
    empty_weight: listing.emptyWeight?.toString() ?? null,
    empty_weight_unit: listing.emptyWeight ? "kg" : null,
    fuel_capacity: listing.fuelCapacity?.toString() ?? null,
    fuel_capacity_unit: listing.fuelCapacity ? "L" : null,
    fuel_type: listing.engine?.toLowerCase().includes("rotax") ? "MOGAS" : (listing.fuelType ?? null),
    cruise_speed: listing.cruiseSpeed?.toString() ?? null,
    cruise_speed_unit: listing.cruiseSpeed ? "km/h" : null,
    max_speed: listing.maxSpeed?.toString() ?? null,
    max_speed_unit: listing.maxSpeed ? "km/h" : null,
    max_range: listing.maxRange?.toString() ?? null,
    max_range_unit: listing.maxRange ? "km" : null,
    service_ceiling: listing.serviceCeiling?.toString() ?? null,
    service_ceiling_unit: listing.serviceCeiling ? "m" : null,
    performance_climb_rate: listing.climbRate?.toString() ?? null,
    performance_climb_rate_unit: listing.climbRate ? "m/s" : null,
    performance_fuel_consumption: listing.fuelConsumption?.toString() ?? null,
    performance_fuel_consumption_unit: listing.fuelConsumption ? "L/h" : null,
    last_annual_inspection: isValidIsoDate(listing.annualInspection) ? listing.annualInspection : null,
    airworthy: listing.airworthy !== null ? (listing.airworthy ? "yes" : "no") : null,

    // Avionics — classified into specific columns; reference_specs fills remaining nulls
    // has_glass_cockpit scans both avionics text and description for broader keyword coverage
    ...classifyAvionicsText(
      [listing.avionicsText, listing.description].filter(Boolean).join('; ') || null
    ),

    // Equipment features — detected from listing text via aircraft_features DB lookup
    feature_ids: featureIds.length > 0 ? featureIds : null,

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


/**
 * Extract city name from free text (description, title).
 * Looks for "Standort:", "Raum", postal codes, or "in <City>" patterns.
 */
function extractCityFromText(text: string): string | null {
  // Structured patterns first
  const structuredMatch =
    text.match(/(?:Standort|Raum|Region|Nähe|stationiert\s+(?:in|bei))[:\s]*([A-ZÄÖÜ][a-zäöüß]+(?:\s+[a-zäöüß]+)?)/i) ??
    text.match(/\b(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]{2,})/); // German postal code + city

  if (structuredMatch) {
    // For postal code match, city is in group 2; for others, group 1
    const city = structuredMatch[2] ?? structuredMatch[1];
    return city.replace(/^(?:Standort|Raum|Region|Nähe)[:\s]*/i, "").trim();
  }

  return null;
}

/**
 * Extract airfield/airport name from free text.
 */
function extractAirfieldFromText(text: string): string | null {
  const match = text.match(
    /(?:Flugplatz|Flughafen|Heimatflugplatz|Heimatflughafen|Flugfeld|Sonderlandeplatz|Verkehrslandeplatz|Landeplatz|UL-Gelände|UL-Platz|stationiert\s+(?:in|am|auf))[:\s]*([^\n•,.]+)/i
  );
  if (match) {
    // Clean out ICAO codes from the name
    return match[1].replace(/\b(ED[A-Z]{2}|LO[A-Z]{2}|LS[A-Z]{2})\b\s*/g, "").trim() || null;
  }
  return null;
}

/**
 * Extract ICAO code from free text.
 * German ICAO: EDxx, Austrian: LOxx, Swiss: LSxx
 */
function extractIcaoFromText(text: string): string | null {
  // Common European ICAO prefixes: ED=DE, LO=AT, LS=CH, EG=UK, LF=FR, EB=BE,
  // LP=PT, LE=ES, LK=CZ, EP=PL, EH=NL, LI=IT, EK=DK, ES=SE, EN=NO, EF=FI
  const match = text.match(/\b((?:ED|LO|LS|EG|LF|EB|LP|LE|LK|EP|EH|LI|EK|ES|EN|EF)[A-Z]{2})\b/);
  return match ? match[1] : null;
}

/**
 * Extract email address from free text (description).
 */
function extractEmailFromText(text: string): string | null {
  const match = text.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
  return match ? match[0] : null;
}

/**
 * Extract aircraft registration / call sign from text.
 * Patterns: D-MSEW (Germany), HB-YGX (Switzerland), OE-ABC (Austria),
 * N12345A (USA), G-ABCD (UK), F-GHIJ (France), etc.
 */
function extractRegistration(text: string): string | null {
  // European: 1-2 letter country prefix + dash + 2-5 alphanumeric chars
  const euroMatch = text.match(/\b([A-Z]{1,2}-[A-Z0-9]{2,5})\b/);
  if (euroMatch) return euroMatch[1];

  // US N-number: N + 1-5 digits + optional 1-2 letters
  const usMatch = text.match(/\b(N\d{1,5}[A-Z]{0,2})\b/);
  if (usMatch) return usMatch[1];

  return null;
}

/**
 * Extract serial number / Werk-Nr from text.
 * Patterns: "Werk Nr. 123", "S/N 12345", "Serial: ABC123"
 */
function extractSerialNumber(text: string): string | null {
  const match =
    text.match(/(?:Werk[- ]?Nr\.?|S\/N|Serial(?:\s*No\.?)?|Seriennummer)[:\s]*([A-Z0-9][\w-]{1,20})/i);
  return match ? match[1].trim() : null;
}

/**
 * Extract phone number from free text (description).
 */
function extractPhoneFromText(text: string): string | null {
  const match = text.match(
    /(?:Tel\.?|Telefon|Mobil|Handy|Phone|Fon)[:\s]*([\d\s/+()-]{7,20})/i
  );
  return match ? match[1].trim() : null;
}

/**
 * City → state/canton/Bundesland code mapping for DACH region (Germany, Austria, Switzerland).
 * Uses abbreviated codes matching what the StateCombobox stores from the `states` DB table.
 *
 * Germany: BY BW HE NW NI SH RP SN BB TH ST MV SL BE HH HB
 * Austria: W NÖ OÖ S T V K ST B  (Bundesland codes)
 * Switzerland: ZH BE LU SZ ZG FR SO BS BL SH SG GR AG TG TI VD VS NE GE JU (canton codes)
 */
const GERMAN_CITY_TO_STATE: Record<string, string> = {
  // ── Bavaria / Bayern (BY) ─────────────────────────────────────────────────
  "münchen": "BY", "munich": "BY", "augsburg": "BY", "nürnberg": "BY", "nuremberg": "BY",
  "regensburg": "BY", "würzburg": "BY", "ingolstadt": "BY", "straubing": "BY",
  "landshut": "BY", "rosenheim": "BY", "kempten": "BY", "memmingen": "BY",
  "bayreuth": "BY", "bamberg": "BY", "passau": "BY", "erding": "BY",
  "fürstenfeldbruck": "BY", "jesenwang": "BY", "oberschleißheim": "BY",
  "landsberg": "BY", "landsberg am lech": "BY", "kaufbeuren": "BY",
  "weilheim": "BY", "weilheim in oberbayern": "BY",
  "garmisch": "BY", "garmisch-partenkirchen": "BY",
  "traunstein": "BY", "altötting": "BY", "deggendorf": "BY",
  "schwabach": "BY", "ansbach": "BY", "fürth": "BY",
  "erlangen": "BY", "hof": "BY", "schweinfurt": "BY", "coburg": "BY",
  "amberg": "BY", "weiden": "BY", "neumarkt": "BY", "neumarkt in der oberpfalz": "BY",
  "dachau": "BY", "freising": "BY", "ebersberg": "BY", "starnberg": "BY",
  "germering": "BY", "puchheim": "BY", "gauting": "BY", "olching": "BY",
  "gröbenzell": "BY", "maisach": "BY", "neufahrn": "BY", "moosburg": "BY",
  "vilsbiburg": "BY", "dingolfing": "BY", "landau an der isar": "BY",
  "plattling": "BY", "regen": "BY", "grafenau": "BY", "freyung": "BY",
  "pfarrkirchen": "BY", "eggenfelden": "BY", "mühldorf": "BY",
  "waldkraiburg": "BY", "wasserburg": "BY", "prien": "BY",
  "aschau": "BY", "traunreut": "BY", "freilassing": "BY",
  "bad reichenhall": "BY", "berchtesgaden": "BY",
  "bad aibling": "BY", "bad tölz": "BY", "miesbach": "BY",
  "wolfratshausen": "BY", "holzkirchen": "BY", "herrsching": "BY",
  "neuburg": "BY", "neuburg an der donau": "BY",
  "günzburg": "BY", "illertissen": "BY", "lauingen": "BY",
  "dillingen": "BY", "dillingen an der donau": "BY",
  "nördlingen": "BY", "donauwörth": "BY", "aichach": "BY",
  "schrobenhausen": "BY", "pfaffenhofen": "BY",
  "füssen": "BY", "immenstadt": "BY", "lindau": "BY",
  "sonthofen": "BY", "oberstdorf": "BY",
  "marktoberdorf": "BY", "buchloe": "BY", "türkheim": "BY",
  "bad wörishofen": "BY", "mindelheim": "BY",
  "neu-ulm": "BY", "senden": "BY",
  "haar": "BY", "vaterstetten": "BY", "markt schwaben": "BY",
  "poing": "BY", "grafing": "BY", "aßling": "BY",
  // ── Baden-Württemberg (BW) ────────────────────────────────────────────────
  "stuttgart": "BW", "karlsruhe": "BW", "freiburg": "BW", "freiburg im breisgau": "BW",
  "mannheim": "BW", "heidelberg": "BW", "ulm": "BW",
  "friedrichshafen": "BW", "donaueschingen": "BW", "konstanz": "BW",
  "heilbronn": "BW", "pforzheim": "BW", "reutlingen": "BW",
  "leutkirch": "BW", "biberach": "BW", "ravensburg": "BW",
  "tübingen": "BW", "aalen": "BW", "esslingen": "BW",
  "göppingen": "BW", "heidenheim": "BW", "ludwigsburg": "BW",
  "offenburg": "BW", "rottweil": "BW", "schwäbisch gmünd": "BW",
  "schwäbisch hall": "BW", "sigmaringen": "BW", "tuttlingen": "BW",
  "villingen-schwenningen": "BW", "waiblingen": "BW",
  "freudenstadt": "BW", "balingen": "BW", "calw": "BW",
  "sindelfingen": "BW", "böblingen": "BW", "leonberg": "BW",
  "fellbach": "BW", "schorndorf": "BW", "backnang": "BW",
  "crailsheim": "BW", "ellwangen": "BW",
  "überlingen": "BW", "radolfzell": "BW", "singen": "BW",
  "wangen": "BW", "wangen im allgäu": "BW",
  "bad saulgau": "BW", "bad waldsee": "BW",
  "kehl": "BW", "lahr": "BW", "achern": "BW",
  "bruchsal": "BW", "rastatt": "BW", "ettlingen": "BW",
  "mosbach": "BW", "sinsheim": "BW", "eberbach": "BW",
  "bad mergentheim": "BW", "künzelsau": "BW",
  "nürtingen": "BW", "kirchheim": "BW", "kirchheim unter teck": "BW",
  "metzingen": "BW", "bad urach": "BW",
  "albstadt": "BW", "haigerloch": "BW",
  "meersburg": "BW", "markdorf": "BW",
  // ── Hesse / Hessen (HE) ──────────────────────────────────────────────────
  "frankfurt": "HE", "frankfurt am main": "HE",
  "wiesbaden": "HE", "kassel": "HE", "darmstadt": "HE",
  "gießen": "HE", "marburg": "HE", "fulda": "HE", "egelsbach": "HE",
  "offenbach": "HE", "offenbach am main": "HE",
  "hanau": "HE", "bad homburg": "HE",
  "rüsselsheim": "HE", "bad hersfeld": "HE",
  "bensheim": "HE", "büdingen": "HE",
  "groß-gerau": "HE", "limburg": "HE", "langen": "HE",
  "wetzlar": "HE", "friedberg": "HE",
  "butzbach": "HE", "bad nauheim": "HE",
  "korbach": "HE", "frankenberg": "HE",
  "eschwege": "HE", "witzenhausen": "HE",
  "hersfeld": "HE",
  // ── North Rhine-Westphalia / Nordrhein-Westfalen (NW) ────────────────────
  "köln": "NW", "cologne": "NW",
  "düsseldorf": "NW", "dortmund": "NW",
  "essen": "NW", "bonn": "NW", "münster": "NW",
  "aachen": "NW", "bielefeld": "NW", "wuppertal": "NW",
  "bochum": "NW", "duisburg": "NW", "paderborn": "NW",
  "gelsenkirchen": "NW", "hagen": "NW", "hamm": "NW",
  "herne": "NW", "krefeld": "NW", "leverkusen": "NW",
  "mönchengladbach": "NW", "mülheim": "NW", "mülheim an der ruhr": "NW",
  "oberhausen": "NW", "remscheid": "NW", "solingen": "NW",
  "bottrop": "NW", "recklinghausen": "NW", "lünen": "NW",
  "siegen": "NW", "neuss": "NW", "moers": "NW",
  "gütersloh": "NW", "herford": "NW", "iserlohn": "NW",
  "witten": "NW", "schwelm": "NW", "velbert": "NW",
  "kleve": "NW", "wesel": "NW", "dinslaken": "NW",
  "düren": "NW", "jülich": "NW", "bergheim": "NW",
  "euskirchen": "NW", "bad godesberg": "NW",
  "minden": "NW", "detmold": "NW", "lemgo": "NW",
  "lippstadt": "NW", "soest": "NW", "arnsberg": "NW",
  "meschede": "NW", "olpe": "NW", "attendorn": "NW",
  // ── Lower Saxony / Niedersachsen (NI) ────────────────────────────────────
  "hannover": "NI", "hanover": "NI",
  "braunschweig": "NI", "brunswick": "NI",
  "osnabrück": "NI", "oldenburg": "NI", "wolfsburg": "NI",
  "hildesheim": "NI", "göttingen": "NI", "celle": "NI",
  "wilhelmshaven": "NI", "delmenhorst": "NI", "emden": "NI",
  "salzgitter": "NI", "hameln": "NI", "lüneburg": "NI",
  "wolfenbüttel": "NI", "goslar": "NI",
  "northeim": "NI", "einbeck": "NI",
  "cuxhaven": "NI", "bremerhaven": "HB",
  "stade": "NI", "buxtehude": "NI",
  "uelzen": "NI", "lüchow": "NI",
  "nienburg": "NI", "schaumburg": "NI",
  "lingen": "NI", "nordhorn": "NI", "meppen": "NI",
  "cloppenburg": "NI", "vechta": "NI",
  "peine": "NI", "seesen": "NI",
  "bad harzburg": "NI", "clausthal-zellerfeld": "NI",
  // ── Schleswig-Holstein (SH) ───────────────────────────────────────────────
  "kiel": "SH", "lübeck": "SH", "flensburg": "SH",
  "neumünster": "SH", "husum": "SH", "heide": "SH",
  "norderstedt": "SH", "pinneberg": "SH",
  "rendsburg": "SH", "schleswig": "SH", "itzehoe": "SH",
  "ahrensburg": "SH", "reinbek": "SH",
  "elmshorn": "SH",
  "bad segeberg": "SH", "bad oldesloe": "SH",
  "eutin": "SH", "plön": "SH",
  "sylt": "SH", "föhr": "SH",
  // ── Rhineland-Palatinate / Rheinland-Pfalz (RP) ──────────────────────────
  "mainz": "RP", "koblenz": "RP", "trier": "RP", "speyer": "RP",
  "kaiserslautern": "RP", "ludwigshafen": "RP",
  "neustadt an der weinstraße": "RP", "neustadt": "RP",
  "pirmasens": "RP", "worms": "RP", "zweibrücken": "RP",
  "bad kreuznach": "RP", "andernach": "RP", "bingen": "RP",
  "bingen am rhein": "RP",
  "idar-oberstein": "RP", "landau": "RP", "landau in der pfalz": "RP",
  "mayen": "RP", "neuwied": "RP", "sinzig": "RP",
  "frankenthal": "RP", "ingelheim": "RP",
  "alzey": "RP", "oppenheim": "RP",
  "cochem": "RP", "zell": "RP",
  "bitburg": "RP", "prüm": "RP",
  "bernkastel": "RP", "bernkastel-kues": "RP",
  // ── Saxony / Sachsen (SN) ─────────────────────────────────────────────────
  "dresden": "SN", "leipzig": "SN", "chemnitz": "SN",
  "zwickau": "SN", "plauen": "SN",
  "görlitz": "SN", "bautzen": "SN", "freiberg": "SN",
  "grimma": "SN", "meißen": "SN", "riesa": "SN",
  "hoyerswerda": "SN", "kamenz": "SN",
  "delitzsch": "SN", "oschatz": "SN", "döbeln": "SN",
  "annaberg": "SN", "annaberg-buchholz": "SN",
  "aue": "SN", "stollberg": "SN",
  // ── Brandenburg (BB) ─────────────────────────────────────────────────────
  "potsdam": "BB", "strausberg": "BB", "cottbus": "BB",
  "frankfurt an der oder": "BB", "eberswalde": "BB",
  "neuruppin": "BB", "oranienburg": "BB",
  "schwedt": "BB", "senftenberg": "BB",
  "brandenburg": "BB", "brandenburg an der havel": "BB",
  "rathenow": "BB", "pritzwalk": "BB",
  "fürstenwalde": "BB", "eisenhüttenstadt": "BB",
  "königs wusterhausen": "BB", "zossen": "BB",
  "luckenwalde": "BB", "jüterbog": "BB",
  // ── Thuringia / Thüringen (TH) ────────────────────────────────────────────
  "erfurt": "TH", "jena": "TH", "weimar": "TH",
  "gera": "TH", "gotha": "TH", "eisenach": "TH",
  "suhl": "TH", "altenburg": "TH", "nordhausen": "TH",
  "apolda": "TH", "bad langensalza": "TH",
  "ilmenau": "TH", "meiningen": "TH",
  "mühlhausen": "TH", "sondershausen": "TH",
  "rudolstadt": "TH", "saalfeld": "TH",
  "sonneberg": "TH", "hildburghausen": "TH",
  // ── Saxony-Anhalt / Sachsen-Anhalt (ST) ──────────────────────────────────
  "magdeburg": "ST", "halle": "ST", "dessau": "ST",
  "dessau-roßlau": "ST", "wittenberg": "ST",
  "bitterfeld": "ST", "merseburg": "ST",
  "quedlinburg": "ST", "stendal": "ST",
  "zeitz": "ST", "aschersleben": "ST",
  "bernburg": "ST", "halberstadt": "ST",
  "schönebeck": "ST", "wernigerode": "ST",
  "sangerhausen": "ST", "weißenfels": "ST",
  // ── Mecklenburg-Vorpommern (MV) ───────────────────────────────────────────
  "rostock": "MV", "schwerin": "MV", "greifswald": "MV",
  "stralsund": "MV", "neubrandenburg": "MV",
  "wismar": "MV", "güstrow": "MV", "waren": "MV",
  "bergen": "MV", "ribnitz": "MV", "ribnitz-damgarten": "MV",
  "heringsdorf": "MV", "usedom": "MV",
  "ueckermünde": "MV", "demmin": "MV",
  "anklam": "MV", "wolgast": "MV",
  // ── Saarland (SL) ─────────────────────────────────────────────────────────
  "saarbrücken": "SL", "saarlouis": "SL",
  "homburg": "SL", "neunkirchen": "SL",
  "merzig": "SL", "st. ingbert": "SL", "völklingen": "SL",
  // ── City-states (BE / HH / HB) ────────────────────────────────────────────
  "berlin": "BE", "hamburg": "HH", "bremen": "HB",

  // ── Austria / Österreich ──────────────────────────────────────────────────
  // Wien (W)
  "wien": "W", "vienna": "W",
  // Niederösterreich (NÖ)
  "st. pölten": "NÖ", "st pölten": "NÖ", "wiener neustadt": "NÖ",
  "klosterneuburg": "NÖ", "korneuburg": "NÖ", "stockerau": "NÖ",
  "tulln": "NÖ", "krems": "NÖ", "krems an der donau": "NÖ",
  "mistelbach": "NÖ", "mödling": "NÖ", "baden bei wien": "NÖ",
  "amstetten": "NÖ", "waidhofen": "NÖ",
  "gmünd": "NÖ", "zwettl": "NÖ",
  "schwechat": "NÖ", "fischamend": "NÖ",
  // Oberösterreich (OÖ)
  "linz": "OÖ", "wels": "OÖ", "steyr": "OÖ",
  "leonding": "OÖ", "traun": "OÖ", "ansfelden": "OÖ",
  "ried im innkreis": "OÖ", "vöcklabruck": "OÖ",
  "gmunden": "OÖ", "bad ischl": "OÖ",
  "braunau": "OÖ", "braunau am inn": "OÖ",
  "freistadt": "OÖ", "rohrbach": "OÖ",
  "kirchdorf": "OÖ", "schärding": "OÖ",
  "perg": "OÖ", "grieskirchen": "OÖ",
  // Salzburg (S)
  "salzburg": "S", "hallein": "S",
  "zell am see": "S", "bischofshofen": "S",
  "st. johann im pongau": "S", "radstadt": "S",
  "schwarzach": "S", "tamsweg": "S",
  // Tirol (T)
  "innsbruck": "T", "kufstein": "T", "wörgl": "T",
  "schwaz": "T", "kitzbühel": "T", "reutte": "T",
  "imst": "T", "landeck": "T", "lienz": "T",
  "telfs": "T", "hall in tirol": "T",
  // Vorarlberg (V)
  "bregenz": "V", "dornbirn": "V", "feldkirch": "V",
  "bludenz": "V", "lustenau": "V", "hohenems": "V",
  "rankweil": "V", "hard": "V",
  // Kärnten (K)
  "klagenfurt": "K", "villach": "K", "wolfsberg": "K",
  "spittal": "K", "spittal an der drau": "K",
  "feldkirchen": "K", "hermagor": "K",
  "st. veit an der glan": "K",
  // Steiermark (ST-AT) — use "STMK" to avoid clash with German ST
  "graz": "STMK", "leoben": "STMK", "kapfenberg": "STMK",
  "bruck an der mur": "STMK", "mürzzuschlag": "STMK",
  "knittelfeld": "STMK", "judenburg": "STMK",
  "fürstenfeld": "STMK", "feldbach": "STMK",
  "leibnitz": "STMK", "gleisdorf": "STMK",
  "deutschlandsberg": "STMK",
  // Burgenland (B-AT) — use "BGLD" to avoid clash with German BE
  "eisenstadt": "BGLD", "rust": "BGLD",
  "neusiedl am see": "BGLD",
  "oberwart": "BGLD", "güssing": "BGLD",
  "jennersdorf": "BGLD", "mattersburg": "BGLD",

  // ── Switzerland / Schweiz ─────────────────────────────────────────────────
  // Zürich (ZH)
  "zürich": "ZH", "zurich": "ZH", "winterthur": "ZH",
  "dübendorf": "ZH", "kloten": "ZH", "uster": "ZH",
  "bülach": "ZH", "dietikon": "ZH", "horgen": "ZH",
  "wetzikon": "ZH", "regensdorf": "ZH",
  // Bern (BE-CH) — use "BE-CH" to avoid clash with Berlin
  "bern": "BE-CH", "biel": "BE-CH", "biel/bienne": "BE-CH",
  "thun": "BE-CH", "köniz": "BE-CH",
  "langenthal": "BE-CH", "burgdorf": "BE-CH",
  "interlaken": "BE-CH", "belp": "BE-CH",
  // Luzern (LU)
  "luzern": "LU", "lucerne": "LU", "kriens": "LU",
  "emmen": "LU", "sursee": "LU", "willisau": "LU",
  // Schwyz (SZ)
  "schwyz": "SZ", "küssnacht": "SZ",
  "arth": "SZ", "einsiedeln": "SZ",
  // Zug (ZG)
  "zug": "ZG", "baar": "ZG", "steinhausen": "ZG",
  // Fribourg (FR)
  "fribourg": "FR", "bulle": "FR",
  "murten": "FR",
  // Solothurn (SO)
  "solothurn": "SO", "olten": "SO", "grenchen": "SO",
  // Basel-Stadt (BS)
  "basel": "BS", "basle": "BS",
  // Basel-Landschaft (BL)
  "liestal": "BL", "arlesheim": "BL",
  // Schaffhausen (SH-CH) — use "SH-CH" to avoid clash with German SH
  "schaffhausen": "SH-CH",
  // St. Gallen (SG)
  "st. gallen": "SG", "st gallen": "SG", "saint gallen": "SG",
  "rapperswil": "SG", "wil": "SG", "gossau": "SG",
  "altenrhein": "SG",
  // Graubünden (GR)
  "chur": "GR", "davos": "GR", "samedan": "GR",
  "arosa": "GR", "pontresina": "GR", "st. moritz": "GR",
  // Aargau (AG)
  "aarau": "AG", "baden": "AG", "wettingen": "AG",
  "lenzburg": "AG", "brugg": "AG", "rheinfelden": "AG",
  // Thurgau (TG)
  "frauenfeld": "TG", "kreuzlingen": "TG", "amriswil": "TG",
  // Ticino (TI)
  "lugano": "TI", "bellinzona": "TI", "locarno": "TI",
  "mendrisio": "TI", "chiasso": "TI",
  // Vaud (VD)
  "lausanne": "VD", "yverdon": "VD",
  "yverdon-les-bains": "VD", "montreux": "VD",
  "la chaux-de-fonds": "NE",
  // Valais (VS)
  "sion": "VS", "sitten": "VS", "brig": "VS",
  "visp": "VS", "monthey": "VS", "martigny": "VS",
  // Neuchâtel (NE)
  "neuchâtel": "NE", "neuenburg": "NE",
  // Genève (GE)
  "genf": "GE", "genève": "GE", "geneva": "GE",
};

/** Words that indicate description text leaked into a city/location field */
const JUNK_LOCATION_WORDS = [
  // German spec/listing words
  "verkauf", "privatverkauf", "angebot", "flugzeug", "flugzeuges", "aircraft",
  "kontaktdaten", "kontakt", "email", "telefon", "tel", "mobil", "handy",
  "segelfliegergruppe", "segelfluggelände", "verein", "viehheide",
  "mittelhessen", "wartet", "biete", "suche", "hello", "offering",
  "selling", "price", "preis", "baujahr", "betriebsstunden", "motor",
  "data", "sheet", "info", "noreply", "description", "details",
  // Spec units / measurements (leaked from listing body)
  "stunden", "std", " ps", " kw", " hp", " kg", " km", " nm",
  // Location qualifiers that may appear without a real city
  "raum", "nähe", "region", "gebiet", "umgebung", "süd", "nord", "ost", "west",
  "deutschlandweit", "bundesweit", "europaweit", "weltweit",
  // Other noise
  "privatperson", "privatverkäufer", "händler", "dealer", "broker",
  "anfrage", "anfragen", "weiteres", "siehe", "more", "view",
];

/**
 * Validate and sanitize a city/location value.
 * Returns null if the value looks like description text, not a real city name.
 */
function sanitizeCity(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Too short or too long for a city name
  if (trimmed.length < 2 || trimmed.length > 35) return null;

  // Contains multiple lines or bullet points → description bleed
  if (/[\n•]/.test(trimmed)) return null;

  // Contains email-like patterns or URLs
  if (/@|\.com|\.de|\.net|\.org|https?:\/\//.test(trimmed)) return null;

  // Contains any digit (city names never have digits; spec values do)
  if (/\d/.test(trimmed)) return null;

  // All uppercase (likely an abbreviation or ICAO code, not a city)
  if (trimmed === trimmed.toUpperCase() && trimmed.length > 3) return null;

  // Check for junk words (description leaking into location)
  const lower = trimmed.toLowerCase();
  if (JUNK_LOCATION_WORDS.some((w) => lower.includes(w))) return null;

  // Must start with uppercase letter (German/European city names always do)
  if (!/^[A-ZÄÖÜ]/.test(trimmed)) return null;

  // If it's a known city, always accept
  if (GERMAN_CITY_TO_STATE[lower]) return trimmed;

  // Unknown city: max 3 words (e.g. "Bad Aibling", "Frankfurt am Main")
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > 3) return null;

  // Unknown city: each word must start with uppercase or be a short connector
  const CONNECTORS = new Set(["am", "an", "im", "in", "bei", "de", "la", "le", "van", "von", "den"]);
  const words = trimmed.split(/\s+/);
  const validWords = words.every(
    (w) => /^[A-ZÄÖÜ]/.test(w) || CONNECTORS.has(w.toLowerCase())
  );
  if (!validWords) return null;

  return trimmed;
}

/**
 * Look up the state/Bundesland/canton code for a city in the DACH region.
 * Returns the abbreviated code stored by the StateCombobox (BY, BW, RP, W, ZH, …).
 */
function resolveGermanState(city: string | null): string | null {
  if (!city) return null;
  return GERMAN_CITY_TO_STATE[city.toLowerCase()] ?? null;
}

function isValidIsoDate(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}

/**
 * Classify raw avionics text into specific DB columns.
 * Priority: TCAS/traffic > Transponder/ADS-B > Autopilot > GPS/Nav > Radios > Other
 */
/** Keywords that indicate a glass cockpit / EFIS avionics suite */
const GLASS_COCKPIT_KW = [
  'EFIS', 'Glass Cockpit', 'Glascockpit', 'G1000', 'G2000', 'G3000', 'G5000',
  'G430W', 'G530W', 'G430', 'G530', 'G500', 'G600', 'G700', 'GTN 650', 'GTN 750',
  'GTN650', 'GTN750', 'GNS 430', 'GNS 530', 'GNS430', 'GNS530',
  'Avidyne', 'Aspen', 'Dynon', 'SkyView', 'Cirrus Perspective',
  'Garmin G', 'MFD', 'PFD', 'EICAS', 'Electronic Flight',
];

function classifyAvionicsText(raw: string | null): {
  avionics_gps: string | null;
  avionics_autopilot: string | null;
  avionics_radios: string | null;
  avionics_transponder: string | null;
  avionics_tcas: string | null;
  avionics_other: string | null;
  has_glass_cockpit: boolean;
} {
  const empty = { avionics_gps: null, avionics_autopilot: null, avionics_radios: null, avionics_transponder: null, avionics_tcas: null, avionics_other: null, has_glass_cockpit: false };
  if (!raw) return empty;

  const segments = raw.split(/[;]+/).map((s) => s.trim()).filter((s) => s.length > 2);
  const gps: string[] = [], ap: string[] = [], radio: string[] = [], xpdr: string[] = [], tcas: string[] = [], other: string[] = [];

  const GPS_KW   = ['GPS', 'GNSS', 'Garmin', 'Dynon', 'SkyDemon', 'SkyView', 'EFIS', 'Glass Cockpit', 'G430', 'G500', 'G600', 'GTN', 'GNS', 'Moving Map', 'MFD', 'PFD', 'Navigat', 'Navi', 'Avmap', 'Naviter'];
  const AP_KW    = ['Autopilot', 'Autoflight', 'Autoland', 'AP '];
  const RADIO_KW = ['Funk', 'COM ', ' COM', 'NAV ', ' NAV', 'VOR', 'ILS', 'DME', 'ADF', 'Becker', 'Trig', 'Bendix', 'King', 'Radio', 'KY-', 'KX-', 'AR ', 'SL40', 'SL30', 'KT-', 'Frequenz', 'Sprechfunk', 'UKW'];
  const XPDR_KW  = ['Transponder', 'XPDR', 'XPNDR', 'Mode-S', 'Mode S', 'Mode-C', 'Mode C', 'ADS-B', 'ADSB', 'GTX', 'Squawk'];
  const TCAS_KW  = ['TCAS', 'FLARM', 'PowerFLARM', 'Traffic Alert', 'PCAS', 'Kollisions', 'TAS '];

  for (const seg of segments) {
    if (TCAS_KW.some((k) => seg.includes(k)))       tcas.push(seg);
    else if (XPDR_KW.some((k) => seg.includes(k)))  xpdr.push(seg);
    else if (AP_KW.some((k) => seg.includes(k)))    ap.push(seg);
    else if (GPS_KW.some((k) => seg.includes(k)))   gps.push(seg);
    else if (RADIO_KW.some((k) => seg.includes(k))) radio.push(seg);
    else                                              other.push(seg);
  }

  // Detect glass cockpit from the full raw string (not just segments)
  const has_glass_cockpit = GLASS_COCKPIT_KW.some((kw) => raw.includes(kw));

  return {
    avionics_gps:         gps.length   > 0 ? gps.join(', ')   : null,
    avionics_autopilot:   ap.length    > 0 ? ap.join(', ')    : null,
    avionics_radios:      radio.length > 0 ? radio.join(', ') : null,
    avionics_transponder: xpdr.length  > 0 ? xpdr.join(', ')  : null,
    avionics_tcas:        tcas.length  > 0 ? tcas.join(', ')  : null,
    avionics_other:       other.length > 0 ? other.join(', ') : null,
    has_glass_cockpit,
  };
}

/** Cache of aircraft_features for keyword matching */
let featuresCache: Array<{ id: number; name: string }> | null = null;

async function loadFeaturesCache(): Promise<Array<{ id: number; name: string }>> {
  if (featuresCache) return featuresCache;
  const { data } = await supabase.from("aircraft_features").select("id, name");
  featuresCache = (data ?? []).filter((f: any) => f.id && f.name) as Array<{ id: number; name: string }>;
  return featuresCache;
}

/**
 * Detect aircraft feature IDs by matching listing text against known aircraft_features names.
 * Only matches meaningful keywords (4+ chars) to avoid false positives.
 */
async function detectFeatureIds(text: string): Promise<number[]> {
  const features = await loadFeaturesCache();
  const textLower = text.toLowerCase();
  const matched: number[] = [];

  for (const feature of features) {
    const nameLower = feature.name.toLowerCase();
    // Split feature name into key terms, skip short stop-words
    const keyTerms = nameLower
      .split(/[\s/,\-()]+/)
      .filter((t) => t.length >= 4)
      .filter((t) => !['with', 'and', 'the', 'for', 'system'].includes(t));

    if (keyTerms.length > 0 && keyTerms.some((term) => textLower.includes(term))) {
      matched.push(feature.id);
    }
  }

  return matched;
}

/**
 * Log a draft listing to admin_activity_logs for review.
 * Admin dashboard shows these under the Activity tab.
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
