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
 * Returns manufacturer name if found (for slug/DB use), null otherwise.
 */
async function resolveManufacturerFromTitle(title: string): Promise<string | null> {
  const manufacturers = await loadRefSpecManufacturers();
  const lower = title.toLowerCase();
  for (const mfr of manufacturers) {
    if (lower.includes(mfr.toLowerCase())) return mfr;
  }
  return null;
}

// ─── Aircraft category helpers ────────────────────────────────────────────────

type AircraftCategory =
  | "Jet"
  | "Turboprop"
  | "Piston Single"
  | "Piston Twin"
  | "LSA"
  | "Helicopter"
  | "Glider"
  | "Ultralight"
  | "Amphibian"
  | "Balloon"
  | "Gyroplane"
  | "Drone"
  | "Other";

/**
 * Derive aircraft category from a listing.
 *
 * Priority order (highest → lowest):
 *   1. Parser-supplied `aircraftType` (always wins when present)
 *   2. Keywords in title / description
 *   3. Engine count / type heuristics (seats, engineCount, engineType)
 *   4. Fall-back → "Other"
 *
 * The old code checked `aircraftType` LAST, so a title-keyword hit for "LSA"
 * could override an explicit `aircraftType: "Jet"` coming from the parser.
 * This version checks it FIRST to fix that bug.
 */
function deriveAircraftCategory(listing: ParsedAircraftListing): AircraftCategory {
  // ── 1. Parser-supplied type always wins ──────────────────────────────────
  if (listing.aircraftType) {
    const t = listing.aircraftType.toLowerCase();
    if (t.includes("jet")) return "Jet";
    if (t.includes("turboprop") || t.includes("turbo prop")) return "Turboprop";
    if (t.includes("piston twin") || t.includes("twin engine")) return "Piston Twin";
    if (t.includes("piston") || t.includes("piston single")) return "Piston Single";
    if (
      t.includes("lsa") ||
      t.includes("light sport") ||
      t.includes("lightsport") ||
      t.includes("ultraleicht") ||
      t.includes("ul-flugzeug") ||
      t.includes("ul flugzeug")
    )
      return "LSA";
    if (t.includes("ultralight") || t.includes("microlight") || t.includes("ultraleicht"))
      return "Ultralight";
    if (t.includes("helicopter") || t.includes("hubschrauber")) return "Helicopter";
    if (t.includes("glider") || t.includes("segelflugzeug")) return "Glider";
    if (t.includes("amphibian") || t.includes("seaplane") || t.includes("flying boat"))
      return "Amphibian";
    if (t.includes("balloon") || t.includes("ballon")) return "Balloon";
    if (t.includes("gyroplane") || t.includes("gyrocopter") || t.includes("autogyro"))
      return "Gyroplane";
    if (t.includes("drone") || t.includes("uav") || t.includes("unmanned")) return "Drone";
  }

  // ── 2. Keyword scan on title + description ───────────────────────────────
  const text = `${listing.title ?? ""} ${listing.description ?? ""}`.toLowerCase();

  if (text.includes("jet") || text.includes("turbojet") || text.includes("turbofan"))
    return "Jet";
  if (text.includes("turboprop") || text.includes("turbo prop")) return "Turboprop";
  if (text.includes("helicopter") || text.includes("hubschrauber")) return "Helicopter";
  if (text.includes("gyroplane") || text.includes("gyrocopter") || text.includes("autogyro"))
    return "Gyroplane";
  if (text.includes("balloon") || text.includes("ballon")) return "Balloon";
  if (text.includes("glider") || text.includes("segelflugzeug")) return "Glider";
  if (text.includes("amphibian") || text.includes("seaplane") || text.includes("flying boat"))
    return "Amphibian";
  if (text.includes("drone") || text.includes("uav")) return "Drone";
  if (
    text.includes("lsa") ||
    text.includes("light sport") ||
    text.includes("lightsport") ||
    text.includes("ultraleicht") ||
    text.includes("ul-flugzeug") ||
    text.includes("ul flugzeug")
  )
    return "LSA";
  if (text.includes("ultralight") || text.includes("microlight")) return "Ultralight";

  // ── 3. Engine / seat heuristics ───────────────────────────────────────────
  const eng = (listing.engineType ?? "").toLowerCase();
  if (eng.includes("jet") || eng.includes("turbofan") || eng.includes("turbojet")) return "Jet";
  if (eng.includes("turboprop") || eng.includes("turbo prop")) return "Turboprop";

  const ec = listing.engineCount ?? 1;
  if (ec >= 2) return "Piston Twin";

  return "Piston Single";
}

// ─── Slug helpers ─────────────────────────────────────────────────────────────

async function buildAircraftSlug(listing: ParsedAircraftListing): Promise<string> {
  const manufacturer = await resolveManufacturerFromTitle(listing.title ?? "");
  return generateSlug({
    manufacturer: manufacturer ?? undefined,
    model: listing.model,
    year: listing.year,
    country: listing.country,
    title: listing.title ?? "",
  });
}

// ─── Upsert helpers ───────────────────────────────────────────────────────────

type UpsertPayload = Record<string, unknown>;

async function upsertAircraftWithSlug(
  payload: UpsertPayload,
  listing: ParsedAircraftListing
): Promise<{ id: number; slug: string } | null> {
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const slug = attempt === 0 ? payload.slug : await buildAircraftSlug(listing);
    const finalSlug = attempt === 0 ? slug : `${slug}-${attempt}`;

    const { data, error } = await supabase
      .from("aircrafts")
      .upsert({ ...payload, slug: finalSlug }, { onConflict: "source_url" })
      .select("id, slug")
      .single();

    if (!error && data) return data as { id: number; slug: string };

    // Duplicate slug → retry with suffix
    const isSlugConflict =
      error?.code === "23505" && error?.message?.includes("aircrafts_slug_key");
    if (!isSlugConflict) {
      logger.error("Upsert failed", { error, slug: finalSlug });
      return null;
    }
  }

  logger.error("Slug conflict unresolved after retries", { url: listing.sourceUrl });
  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function upsertAircraftListing(listing: ParsedAircraftListing): Promise<void> {
  try {
    const slug = await buildAircraftSlug(listing);
    const category = deriveAircraftCategory(listing);
    const manufacturerMap = await getManufacturerMap();

    // ── Resolve manufacturer FK (optional) ───────────────────────────────────
    let manufacturerId: number | null = null;
    const resolvedMfr = await resolveManufacturerFromTitle(listing.title ?? "");
    if (resolvedMfr) {
      manufacturerId = manufacturerMap.get(resolvedMfr.toLowerCase()) ?? null;
    }

    // ── Resolve reference specs ───────────────────────────────────────────────
    const refSpecs = await lookupReferenceSpecs(listing);

    // ── Translations ──────────────────────────────────────────────────────────
    let translation: TranslationResult | null = null;
    if (config.enableTranslations) {
      translation = await translateListing(listing.title ?? "", listing.description ?? "");
    }

    // ── Image upload ──────────────────────────────────────────────────────────
    let imageUrls: string[] = listing.imageUrls ?? [];
    if (config.enableImageUpload && imageUrls.length > 0) {
      imageUrls = await uploadImages(imageUrls, listing.sourceUrl);
    }

    // ── Build payload ─────────────────────────────────────────────────────────
    const cleanTitle = listing.title ? stripTitleDatePrefix(listing.title) : null;

    const localeFields = buildLocaleFields(LANGS, (lang) => ({
      title: translation?.titles?.[lang] ?? cleanTitle,
      description: translation?.descriptions?.[lang] ?? listing.description ?? null,
    }));

    const payload: UpsertPayload = {
      slug,
      source_url: listing.sourceUrl,
      source_name: listing.sourceName,
      title: cleanTitle,
      description: listing.description ?? null,
      price: listing.price ?? null,
      currency: listing.currency ?? null,
      year: listing.year ?? null,
      total_time: listing.totalTime ?? null,
      engine_time: listing.engineTime ?? null,
      seats: listing.seats ?? null,
      engine_count: listing.engineCount ?? null,
      engine_type: listing.engineType ?? null,
      avionics: listing.avionics ?? null,
      registration: listing.registration ?? null,
      country: listing.country ?? null,
      category,
      image_urls: imageUrls,
      manufacturer_id: manufacturerId,
      model: listing.model ?? null,
      last_seen_at: new Date().toISOString(),
      ...localeFields,
    };

    // Apply reference specs if found
    if (refSpecs) {
      applyReferenceSpecs(payload, refSpecs);
    }

    // ── Upsert ────────────────────────────────────────────────────────────────
    const result = await upsertAircraftWithSlug(payload, listing);
    if (!result) return;

    logger.info("Upserted aircraft", {
      id: result.id,
      slug: result.slug,
      url: listing.sourceUrl,
    });
  } catch (err) {
    logger.error("Failed to upsert aircraft listing", { err, url: listing.sourceUrl });
  }
}

// ─── Reference spec seeding ───────────────────────────────────────────────────

/**
 * Seed a new manufacturer+model into aircraft_reference_specs if it doesn't
 * already exist. Called opportunistically during crawls so the reference table
 * grows organically with real-world data.
 */
export async function seedReferenceSpec(
  manufacturer: string,
  model: string,
  variant: string,
  title: string
): Promise<void> {
  try {
    await (supabase as any).from("aircraft_reference_specs").upsert(
      {
        manufacturer,
        model,
        variant,
        notes: `Auto-seeded from crawl title: "${title.slice(0, 200)}"`,
      },
      { onConflict: "manufacturer,model,variant", ignoreDuplicates: true }
    );
  } catch {
    // Non-critical — don't fail the crawl for reference seeding issues
  }
}
