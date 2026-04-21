import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import { uploadImages } from "../utils/images.js";
import { translateListing, type TranslationResult } from "../utils/translate.js";
import { extractStructuredData, applyExtractedData, deduplicateDescription } from "../utils/extract.js";
import { generateSlug } from "../utils/slug.js";
import { LANGS, buildLocaleFields } from "./locale-helpers.js";
import { lookupReferenceSpecs, applyReferenceSpecs, lookupCategoryFromRefSpecs, scanHeadlineForKnownModel } from "./reference-specs.js";
import type { ParsedAircraftListing } from "../types.js";
import { stripTitleDatePrefix } from "../parsers/shared.js";
import { enqueueInviteCandidate } from "./invite-candidates.js";

let manufacturerCache: Map<string, number> | null = null;
let refSpecManufacturers: string[] | null = null;

/**
 * Map legacy / alternate manufacturer names to the canonical name used in
 * aircraft_reference_specs.  When a listing title contains an alias (left),
 * we resolve it to the canonical name (right) so that category lookup and
 * reference-spec enrichment work correctly.
 *
 * Sorted longest-first so "AgustaWestland" matches before "Agusta".
 */
const MANUFACTURER_ALIASES: Record<string, string> = {
  // AgustaWestland → rebranded to Leonardo Helicopters in 2016
  "agustawestland": "Leonardo",
  "agusta westland": "Leonardo",
  "agusta": "Leonardo",
  // Eurocopter → rebranded to Airbus Helicopters in 2014
  "eurocopter": "Airbus Helicopters",
  // MBB → merged into Eurocopter, now Airbus Helicopters
  "mbb": "Airbus Helicopters",
  // Aerospatiale helicopters → Airbus Helicopters
  "aerospatiale": "Airbus Helicopters",
  // Sikorsky alternate
  "sikorski": "Sikorsky",
  // Hawker Beechcraft → split into Beechcraft (pistons) and Hawker (jets)
  "hawker beechcraft": "Beechcraft",
  // Daher-Socata → Daher acquired Socata
  "daher-socata": "Daher",
  "daher socata": "Daher",
  // De Havilland alternate spellings
  "dehavilland": "De Havilland",
  "de havilland canada": "De Havilland",
  // Vulcanair ← Partenavia
  "partenavia": "Vulcanair",
  // Short-name aliases → canonical names for consistent DB entries
  "ikarus": "Comco Ikarus",
  "comco ikarus": "Comco Ikarus",
  "fk9": "FK Lightplanes",
  "fk14": "FK Lightplanes",
  "fk lightplanes": "FK Lightplanes",
  "i.c.p": "ICP",
  // Robinson vs Robin disambiguation handled in resolveManufacturer()
};

/** Sorted alias keys longest-first for greedy matching */
const ALIAS_KEYS = Object.keys(MANUFACTURER_ALIASES).sort((a, b) => b.length - a.length);

async function loadRefSpecManufacturers(): Promise<string[]> {
  if (refSpecManufacturers) return refSpecManufacturers;
  const { data } = await (supabase as any).from("aircraft_reference_specs").select("manufacturer");
  const raw: string[] = (data ?? []).map((r: any) => r.manufacturer as string).filter(Boolean);
  refSpecManufacturers = [...new Set(raw)].sort((a, b) => b.length - a.length);
  return refSpecManufacturers;
}

async function getManufacturerMap(): Promise<Map<string, number>> {
  if (manufacturerCache) return manufacturerCache;
  const { data } = await supabase.from("aircraft_manufacturers").select("id, name");
  manufacturerCache = new Map((data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  return manufacturerCache;
}

async function resolveManufacturer(title: string): Promise<string | null> {
  const lower = title.toLowerCase();

  // 0. Robin vs Robinson disambiguation — Robinson helicopter models (R22, R44, R66)
  //    contain "robin" as substring, so we must check Robinson first.
  if (/\b(robinson|r[\s-]?22|r[\s-]?44|r[\s-]?66)\b/i.test(title)) {
    // If title contains Robinson helicopter model indicators → Robinson
    if (/\b(r[\s-]?22|r[\s-]?44|r[\s-]?66)\b/i.test(title)) return "Robinson";
    if (lower.includes("robinson")) return "Robinson";
  }

  // 1. Check manufacturer aliases first (handles rebrands like Agusta → Leonardo)
  for (const alias of ALIAS_KEYS) {
    if (lower.includes(alias)) return MANUFACTURER_ALIASES[alias];
  }

  // 2. Match against reference-spec manufacturer names
  const manufacturers = await loadRefSpecManufacturers();
  for (const m of manufacturers) { if (lower.includes(m.toLowerCase())) return m; }
  return null;
}

/**
 * Extract a clean model name from the listing title by removing the
 * manufacturer name and filtering out garbage tokens (engine names,
 * registrations, prices, German listing metadata).
 *
 * If a reference spec match exists, prefer its clean model name.
 */
function extractModelFromTitle(
  title: string,
  manufacturerName: string | null,
  refSpecs: { ref_model?: string; ref_variant?: string } | null,
): string {
  // 1. Prefer model from reference specs (cleanest source)
  if (refSpecs?.ref_model) {
    const variant = refSpecs.ref_variant;
    return variant ? `${refSpecs.ref_model} ${variant}` : refSpecs.ref_model;
  }

  // 2. Extract from title: remove manufacturer name, then clean up
  let model = title;
  if (manufacturerName) {
    // Remove manufacturer name (case-insensitive)
    model = model.replace(new RegExp(manufacturerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").trim();
  }

  // Remove common German listing prefixes
  model = model
    .replace(/^(zu\s+)?verkauf[e]?\s*[:.]?\s*/i, "")
    .replace(/^(for\s+)?sale\s*[:.]?\s*/i, "")
    .replace(/^angeboten\s+wird\s*/i, "")
    .replace(/^verkaufe\s*[:.]?\s*/i, "")
    .replace(/^biete\s*[:.]?\s*/i, "")
    .trim();

  // Take only the first meaningful segment (before description starts)
  // Split on common delimiters: Baujahr, Betriebsstunden, Motor:, year patterns
  model = model.split(/\s+(?:Baujahr|BJ\.?|Betriebsstunden|TT:|TTAF|Motor:|Standort|Zustand|Preis|EUR|€|\d{2}\.\d{2}\.\d{4})/i)[0].trim();

  // Remove trailing punctuation and whitespace
  model = model.replace(/[\s,;:.!]+$/, "").trim();

  // Reject if result is garbage
  if (!isCleanModel(model)) {
    // Progressive shortening: try the first 3, 2, 1 words before giving up.
    // Recovers clean names like "C42B", "CTSW", "WT9 Dynamic", "M8 Eagle",
    // "A32", "MT 03" from headlines polluted with German marketing prose
    // ("C42B Zum Verkauf aus privater…", "CTSW Wir verkaufen unsere
    // zuverlässige Flight Design CTSW…", "WT9 Dynamic mit nagelneuem
    // Motor 912 ULS…"). The full-title 60-char fallback this replaces
    // routinely pushed sentence fragments into aircraft_listings.model.
    const words = model.split(/\s+/).filter(Boolean);
    for (let len = Math.min(3, words.length); len >= 1; len--) {
      const candidate = words.slice(0, len).join(" ").trim();
      if (isCleanModel(candidate)) return candidate;
    }
    // No usable prefix — leave the caller to decide. Empty string signals
    // "unextractable"; the caller's ref-spec headline-scan fallback
    // (extractModelFromTitle → scanHeadlineForKnownModel) should still
    // recover a real model if one exists in aircraft_reference_specs.
    return "";
  }

  // Cap length
  return model.slice(0, 80);
}

/**
 * Check if a model string is clean (not engine name, registration, price,
 * German filler, or a description fragment).
 *
 * Hardened per docs/CRAWLER_HANDOVER_CATEGORY_MODEL_DEDUP.md Task 1 — engine
 * strings (Rotax 912 ULS, Continental IO-550, Lycoming O-320, Jabiru 2200)
 * and crawler filler (Demoflugzeug, Einziehfahrwerk, DynonAvionics, Bj.,
 * TTAF, versteuert, AIRCH) must never land in `aircraft_listings.model`.
 */
function isCleanModel(model: string): boolean {
  if (!model || model.length < 2) return false;
  const trimmed = model.trim();

  // Engine brand prefixes anywhere at start
  if (/^(rotax|lycoming|continental|jabiru|hirth|polini|bmw|teledyne|superior)\b/i.test(trimmed)) return false;

  // Rotax engine patterns: "912", "912S", "912 ULS", "912iS", "914 UL", "915is"
  if (/^\s*(rotax\s*)?91[2456]\s*(i?s|uls|ul|is)?\s*$/i.test(trimmed)) return false;
  // Small 2-stroke Rotax: 503, 447, 582 (optionally UL/ULS suffix)
  if (/^\s*(rotax\s*)?(582|503|447)\s*(uls|ul)?\s*$/i.test(trimmed)) return false;

  // Continental engine patterns: O-200, IO-360, IO-470, IO-520, IO-550, TSIO-550
  if (/^(t?s?io?-?(200|240|300|320|346|360|470|520|540|550))\b/i.test(trimmed)) return false;
  // Lycoming engine patterns: O-320, IO-360, O-540, IO-540, AEIO-540, TIO-540
  if (/^(aeio|t?io|o)-?(235|290|320|360|390|480|540|580|720)\b/i.test(trimmed)) return false;
  // Jabiru engine patterns: 2200, 3300 (bare or "Jabiru 2200")
  if (/^(jabiru\s*)?(2200|3300)\b/i.test(trimmed)) return false;

  // Registration numbers: D-MXXX, D-EXXX, HB-XXX, OE-XXX, N12345
  if (/^[A-Z]{1,2}-[A-Z]{2,4}\b/i.test(trimmed)) return false;
  if (/^N\d{1,5}[A-Z]{0,2}$/i.test(trimmed)) return false;

  // Pure price: "26.000", "12500"
  if (/^\d{1,3}([.,]\d{3})*\s*(€|EUR|,-)?$/i.test(trimmed)) return false;
  // Contains email
  if (/@/.test(trimmed)) return false;

  // Too many words (likely description fragment)
  if (trimmed.split(/\s+/).length > 6) return false;

  // German + English crawler filler / description tokens
  if (/\b(zustand|verkauf|baujahr|stunden|preis|motor\b|biete|kaufe|gesucht|aufgabe|demoflu(?:gzeug)?|versteuert|ttaf|airch|einziehfahrwerk|dynon(?:avionics)?|skyview|equipment|ausstattung|inklusive|instrument(?:ierung)?|neuwertig)/i.test(trimmed)) return false;

  // "Bj." / "Bj" (German abbreviation for Baujahr, year of build)
  if (/\bBj\.?\b/i.test(trimmed)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Category detection: uses aircraft_reference_specs table as source of truth,
// falls back to URL/title keyword heuristics for unknown manufacturers.
// ---------------------------------------------------------------------------

function detectCategoryFromUrlAndTitle(sourceUrl: string | undefined, title: string): string | null {
  const url = (sourceUrl ?? "").toLowerCase();
  const t = title.toLowerCase();

  // Helicopter / Gyrocopter
  if (url.includes("/hubschrauber") || url.includes("/helicopter") || t.includes("helicopter") ||
      t.includes("hubschrauber") || t.includes("gyrocopter") || t.includes("autogyro") ||
      t.includes("tragschrauber")) return "Helicopter / Gyrocopter";

  // Glider / Motorglider
  if (url.includes("/segelflugzeug") || url.includes("/glider") || t.includes("glider") ||
      t.includes("segelflugzeug") || t.includes("sailplane") || t.includes("motorsegler") ||
      t.includes("motor glider") || t.includes("tmg")) return "Glider";

  // Microlight / Flex-Wing / Trike
  //
  // Important: keywords are narrowed to avoid false positives. The
  // Microlight/Flex-Wing category is strictly for weight-shift aircraft
  // (hang gliders, paragliders, trikes) — NOT for fixed-wing ULs or LSAs.
  //
  // Previous version matched bare "drachen" (German for dragon/kite),
  // which caused false positives on listings mentioning the word in
  // unrelated contexts (model names, addresses, descriptions). We now
  // require the more specific "drachenflieger" (hang-glider pilot) or
  // "hängedrachen" (hang glider) compounds.
  //
  // "trike" is now also narrowed — a bare substring match would hit
  // words like "trikeshaw" or fragments of unrelated words. We use a
  // word-boundary regex to require "trike" as a standalone word.
  if (
    /\btrike\b/.test(t) || t.includes("flex-wing") || t.includes("flexwing") ||
    t.includes("paramotor") || t.includes("motorschirm") ||
    t.includes("drachenflieger") || t.includes("hängedrachen") ||
    t.includes("hängegleiter") || t.includes("weight-shift") || t.includes("drachenfläche") ||
    url.includes("/trike")
  ) return "Microlight / Flex-Wing";

  // Turboprop
  if (url.includes("/turboprop") || t.includes("turboprop") || t.includes("turbo prop") ||
      t.includes("king air") || t.includes("tbm ") || t.includes("pc-12") || t.includes("caravan") ||
      t.includes("meridian") || t.includes("cheyenne") || t.includes("conquest") ||
      t.includes("epic e1000") || t.includes("kodiak")) return "Turboprop";

  // Jet
  // Matches well-known business-jet family names. "canadair" is added so
  // "Canadair Challenger 604" resolves even if "challenger" is not hit first.
  if (url.includes("/jet") || t.match(/\bjet\b/) || t.includes("citation") ||
      t.includes("phenom") || t.includes("learjet") || t.includes("gulfstream") ||
      t.includes("falcon ") || t.includes("challenger") || t.includes("global ") ||
      t.includes("canadair") || t.includes("hondajet") || t.includes("hawker") ||
      t.includes("praetor") || t.includes("legacy 5") || t.includes("legacy 6") ||
      t.includes("latitude") || t.includes("longitude") || t.includes("beechjet") ||
      t.includes("embraer ") || t.includes("bombardier ") || t.includes("sf50") ||
      t.includes("vision jet")) return "Jet";

  // Multi Engine Piston
  if (t.includes("twin") || t.includes("multi engine") || t.includes("zweimotorig") ||
      t.includes("baron") || t.includes("seneca") || t.includes("seminole") ||
      t.includes("duchess") || t.includes("apache") || url.includes("/multiprop") ||
      url.includes("/mehrmotorig") || t.includes("da42") || t.includes("da62") ||
      t.includes("p2006") || t.includes("tecnam p2006") || t.includes("cessna 310") ||
      t.includes("cessna 340") || t.includes("cessna 414") || t.includes("cessna 421") ||
      t.includes("piper aztec") || t.includes("piper navajo")) return "Multi Engine Piston";

  // Single Engine Piston (common keywords + iconic model families)
  // Added: Yakovlev (Yak-11/18/50/52/55), Nanchang CJ-6, Zlin, Extra, One Design,
  // CAP, Pitts, Sukhoi sport, and other trainers/aerobatic singles that had
  // no keyword coverage and were landing with a null category.
  if (
    url.includes("/singleprop") || url.includes("/einmotorig") ||
    url.includes("/kolbenmotorflugzeug") ||
    // Russian / Soviet aerobatic and trainer singles
    /\byak[-\s]?(3|7|9|11|18|50|52|54|55)\b/.test(t) || t.includes("yakovlev") ||
    t.includes("sukhoi su-26") || t.includes("sukhoi su-29") || t.includes("sukhoi su-31") ||
    t.includes("nanchang") || /\bcj-?6\b/.test(t) ||
    // Czech / European aerobatic + trainer singles
    /\bzlin\b/.test(t) || /\bz-?(42|43|50|142|143|242|526|726)\b/.test(t) ||
    // Aerobatic singles
    t.includes("extra 200") || t.includes("extra 300") || t.includes("extra 330") ||
    t.includes("cap 10") || t.includes("cap 20") || t.includes("cap 21") || t.includes("cap 232") ||
    t.includes("pitts ") || t.includes("one design") || t.includes("mxs-r") ||
    t.includes("gamebird") ||
    // Iconic single-engine piston production aircraft
    t.includes("cessna 150") || t.includes("cessna 152") || t.includes("cessna 170") ||
    t.includes("cessna 172") || t.includes("cessna 175") || t.includes("cessna 177") ||
    t.includes("cessna 180") || t.includes("cessna 182") || t.includes("cessna 185") ||
    t.includes("cessna 195") || t.includes("cessna 205") || t.includes("cessna 206") ||
    t.includes("cessna 207") || t.includes("cessna 210") ||
    t.includes("piper pa-18") || t.includes("piper pa-22") || t.includes("piper pa-24") ||
    t.includes("piper pa-28") || t.includes("piper pa-32") || t.includes("piper pa-46") ||
    t.includes("cherokee") || t.includes("warrior") || t.includes("archer") ||
    t.includes("dakota") || t.includes("saratoga") || t.includes("lance ") ||
    t.includes("arrow") || t.includes("cub") ||
    t.includes("bonanza") || t.includes("debonair") || t.includes("musketeer") ||
    t.includes("sundowner") || t.includes("sierra") ||
    t.includes("mooney m20") || t.includes("mooney ovation") || t.includes("mooney acclaim") ||
    t.includes("cirrus sr") || t.includes("sr20") || t.includes("sr22") ||
    t.includes("diamond da20") || t.includes("diamond da40") ||
    t.includes("robin dr") || /\bdr[- ]?400\b/.test(t) ||
    t.includes("grumman aa") || t.includes("tiger aa5") ||
    t.includes("bellanca ") || t.includes("stinson ") ||
    // Historical / warbird singles (most are piston)
    t.includes("t-6 texan") || t.includes("harvard") || t.includes("t-34 mentor") ||
    t.includes("nord 3202") || t.includes("fouga magister") || t.includes("chipmunk")
  ) return "Single Engine Piston";

  // Experimental / Homebuilt
  if (t.includes("experimental") || t.includes("eigenbau") || t.includes("homebuilt") ||
      t.includes("kit-built") || t.includes("kitbuilt") || t.includes("selbstbau") ||
      url.includes("/experimental") || /\brv-?(3|4|6|7|8|9|10|12|14)\b/.test(t) ||
      t.includes("lancair") || t.includes("glasair") || t.includes("sonex") ||
      t.includes("kitfox")) return "Experimental / Homebuilt";

  // Commercial Airliner
  if (t.includes("airliner") || t.includes("verkehrsflugzeug") || t.includes("boeing 7") ||
      t.includes("airbus a3")) return "Commercial Airliner";

  // Ultralight / LSA (broadest match — last to avoid false positives)
  // Added common modern LSA / UL manufacturers so they resolve without
  // needing a reference-specs entry.
  if (
    url.includes("/ul-") || url.includes("/ultraleicht") || url.includes("ul-flugzeug") ||
    url.includes("helmuts-ul-seiten.de") || t.includes("ultralight") || t.includes("ultraleicht") ||
    t.includes(" ul ") || t.match(/\bul\b/) || t.match(/\blsa\b/) ||
    // Common LSA / UL brands and models
    t.includes("sonaca") || t.includes("flight design ct") || t.includes("flight design f") ||
    t.includes("comco ikarus") || t.includes("ikarus c42") || t.includes("ikarus c-42") ||
    t.includes("c42") || t.includes("breezer") || t.includes("bristell") ||
    t.includes("shark aero") || t.includes("blackshape") || t.includes("lambada") ||
    t.includes("wt-9") || t.includes("wt9") || t.includes("dynamic wt") ||
    t.includes("fk9") || t.includes("fk 9") || t.includes("fk14") || t.includes("fk 14") ||
    t.includes("fk-lightplanes") || t.includes("b&f fk") ||
    t.includes("eurofox") || t.includes("eurostar") || t.includes("p92") || t.includes("p2002") ||
    t.includes("tecnam p92") || t.includes("tecnam p2002") || t.includes("tecnam p96") ||
    t.includes("savannah") || t.includes("savage cub") || t.includes("sportcruiser") ||
    t.includes("piper sport") || t.includes("virus sw") || t.includes("pipistrel")
  ) return "Ultralight / Light Sport Aircraft (LSA)";

  return null;
}

/**
 * Category lookup by registration prefix (German LBA / Austrian / Swiss).
 * Returns a category name or null when the registration doesn't carry
 * enough signal.
 *
 * German prefixes (https://de.wikipedia.org/wiki/Luftfahrzeugkennzeichen):
 *   D-A/D-B >20t / 14-20t (Airliner)
 *   D-C 5.7-14t (Jet — Saab 340, Citation CJ3, Learjet 35)
 *   D-E single engine <2t (Piper PA-28, Cessna 172, Robin DR400)
 *   D-F single engine 2-5.7t (PC-12, An-2, Cessna 208)
 *   D-G multi engine <2t (Diamond DA42 Twin Star, CriCri)
 *   D-H helicopter (EC 135, EC 145)
 *   D-I multi engine 2-5.7t (Piaggio Avanti, Citation CJ1+, Piper PA-42)
 *   D-K motorglider (Grob G 109, Scheibe Falke, Super Dimona)
 *   D-M ultralight <600kg (FK 9, Ikarus C42, Shark Aero UL)
 *   D-N non-motorized sport aircraft (hang glider, paraglider)
 *   D-xxxx pure glider (LS4, K 8, ASK 13, ASK 21, Discus, Astir)
 */
function categoryFromRegistrationPrefix(registration: string | null | undefined): string | null {
  if (!registration) return null;
  const reg = registration.toUpperCase().replace(/\s+/g, "");

  // German (D-) prefixes
  if (/^D-[AB][A-Z]{2,3}$/.test(reg)) return "Commercial Airliner";
  if (/^D-C[A-Z]{2,3}$/.test(reg)) return "Jet";
  if (/^D-E[A-Z]{2,3}$/.test(reg)) return "Single Engine Piston";
  if (/^D-F[A-Z]{2,3}$/.test(reg)) return "Turboprop";
  if (/^D-G[A-Z]{2,3}$/.test(reg)) return "Multi Engine Piston";
  if (/^D-H[A-Z]{2,3}$/.test(reg)) return "Helicopter / Gyrocopter";
  if (/^D-I[A-Z]{2,3}$/.test(reg)) return "Multi Engine Piston";
  if (/^D-K[A-Z]{2,3}$/.test(reg)) return "Glider";
  if (/^D-M[A-Z]{3}$/.test(reg)) return "Ultralight / Light Sport Aircraft (LSA)";
  if (/^D-N[A-Z]{3}$/.test(reg)) return "Microlight / Flex-Wing";
  if (/^D-\d{4}$/.test(reg)) return "Glider";

  // Austrian (OE-)
  if (/^OE-[AC][A-Z]{2}$/.test(reg)) return "Single Engine Piston";
  if (/^OE-B[A-Z]{2}$/.test(reg)) return "Commercial Airliner";
  if (/^OE-[DK][A-Z]{2}$/.test(reg)) return "Single Engine Piston";
  if (/^OE-E[A-Z]{2}$/.test(reg)) return "Turboprop";
  if (/^OE-F[A-Z]{2}$/.test(reg)) return "Multi Engine Piston";
  if (/^OE-G[A-Z]{2}$/.test(reg)) return "Jet";
  if (/^OE-H[A-Z]{2}$/.test(reg)) return "Jet";
  if (/^OE-[IL][A-Z]{2}$/.test(reg)) return "Commercial Airliner";
  if (/^OE-X[A-Z]{2}$/.test(reg)) return "Helicopter / Gyrocopter";
  if (/^OE-W[A-Z]{2}$/.test(reg)) return "Single Engine Piston";

  // Swiss (HB-)
  if (/^HB-[CDEHKNOPSTU][A-Z]{2}$/.test(reg)) return "Single Engine Piston";
  if (/^HB-F[A-Z]{2}$/.test(reg)) return "Turboprop";
  if (/^HB-[GL][A-Z]{2}$/.test(reg)) return "Multi Engine Piston";
  if (/^HB-A[A-Z]{2}$/.test(reg)) return "Turboprop";
  if (/^HB-[IJ][A-Z]{2}$/.test(reg)) return "Commercial Airliner";
  if (/^HB-V[A-Z]{2}$/.test(reg)) return "Jet";
  if (/^HB-M[A-Z]{2}$/.test(reg)) return "Single Engine Piston";
  if (/^HB-R[A-Z]{2}$/.test(reg)) return "Single Engine Piston";
  if (/^HB-W[A-Z]{2}$/.test(reg)) return "Ultralight / Light Sport Aircraft (LSA)";
  if (/^HB-[XZ][A-Z]{2}$/.test(reg)) return "Helicopter / Gyrocopter";
  if (/^HB-Y[A-Z]{2}$/.test(reg)) return "Experimental / Homebuilt";

  return null;
}

/**
 * Feature flag for Task 2 of docs/CRAWLER_HANDOVER_CATEGORY_MODEL_DEDUP.md.
 * When `CATEGORY_RESOLUTION_V2=true`, reference-spec lookup runs BEFORE the
 * registration-prefix rules so a ref-spec match (e.g. Bombardier → Jet)
 * wins even for German D-registered aircraft whose prefix would otherwise
 * force a narrower category. Off by default — flip to true after one clean
 * crawl cycle's diff against the legacy classifier.
 */
const CATEGORY_RESOLUTION_V2 = process.env.CATEGORY_RESOLUTION_V2 === "true";

async function detectCategoryName(sourceUrl: string | undefined, title: string, manufacturerName?: string | null, registration?: string | null): Promise<string | null> {
  if (CATEGORY_RESOLUTION_V2) {
    // V2 precedence (per handover): ref-spec → registration → url/title
    const refCategory = await lookupCategoryFromRefSpecs(title, manufacturerName ?? null);
    if (refCategory) return refCategory;

    const regCategory = categoryFromRegistrationPrefix(registration);
    if (regCategory) return regCategory;

    return detectCategoryFromUrlAndTitle(sourceUrl, title);
  }

  // Legacy precedence (default): registration → ref-spec → url/title
  const regCategory = categoryFromRegistrationPrefix(registration);
  if (regCategory) return regCategory;

  // Reference specs lookup — the table has correct category for every known
  // manufacturer+model combo (475+ entries), preventing e.g. Mooney/Piper/
  // Agusta from being miscategorized as LSA just because they appear on
  // helmuts-ul-seiten.de.
  const refCategory = await lookupCategoryFromRefSpecs(title, manufacturerName ?? null);
  if (refCategory) return refCategory;

  // Last resort: URL/title keyword heuristics for new/unknown manufacturers.
  return detectCategoryFromUrlAndTitle(sourceUrl, title);
}

// ---------------------------------------------------------------------------
// City / country validation — prevents country names in city field,
// strips ICAO codes, airport prefixes, and garbage keywords.
// ---------------------------------------------------------------------------

/** Country names in German + English (lowercase for matching) */
const COUNTRY_NAMES = new Set([
  "germany", "deutschland", "france", "frankreich", "spain", "spanien",
  "italy", "italien", "austria", "österreich", "oesterreich",
  "switzerland", "schweiz", "netherlands", "niederlande", "holland",
  "belgium", "belgien", "poland", "polen", "czech republic", "tschechien",
  "sweden", "schweden", "norway", "norwegen", "denmark", "dänemark",
  "portugal", "greece", "griechenland", "turkey", "türkei",
  "united kingdom", "uk", "usa", "united states", "canada", "kanada",
  "hungary", "ungarn", "romania", "rumänien", "croatia", "kroatien",
  "slovakia", "slowakei", "slovenia", "slowenien", "bulgaria", "bulgarien",
]);

/** Words that are NOT city names */
const INVALID_CITY_WORDS = new Set([
  "factory", "available", "maintenance", "man", "flugplatz", "airport",
  "hangar", "lagerung", "werkstatt", "museum", "studio", "office",
  "base", "depot", "storage", "verkauf", "verkaufe", "verkaufen",
  "privatverkauf", "biete", "angeboten", "angebot", "suche", "trike",
  "cessna", "piper", "beechcraft", "diamond", "cirrus", "mooney",
  "rotax", "lycoming", "continental", "jabiru", "motor", "propeller",
  "baujahr", "betriebsstunden", "stunden", "flugstunden", "preis",
  "einsitzer", "doppelsitzer", "ultraleicht", "ultralight", "experimental",
  "sportflugzeug", "flugzeug", "aircraft", "airplane", "plane",
  "fallen", "defekt", "beschädigt", "unfall", "unfälle", "crashed",
  "telefon", "email", "kontakt", "contact", "noreply", "info",
  "hersteller", "manufacturer", "modell", "model", "type", "typ",
]);

/** German → English country name mapping */
const COUNTRY_MAP: Record<string, string> = {
  "deutschland": "Germany", "frankreich": "France", "spanien": "Spain",
  "italien": "Italy", "österreich": "Austria", "oesterreich": "Austria",
  "schweiz": "Switzerland", "niederlande": "Netherlands", "holland": "Netherlands",
  "belgien": "Belgium", "polen": "Poland", "tschechien": "Czech Republic",
  "schweden": "Sweden", "norwegen": "Norway", "dänemark": "Denmark",
  "griechenland": "Greece", "türkei": "Turkey", "ungarn": "Hungary",
  "rumänien": "Romania", "kroatien": "Croatia", "slowakei": "Slovakia",
  "slowenien": "Slovenia", "bulgarien": "Bulgaria", "kanada": "Canada",
};

function cleanCity(city: string | null, _country?: string | null): string | null {
  if (!city) return null;
  let cleaned = city.trim();
  if (!cleaned) return null;

  // If city is a country name, return null
  if (COUNTRY_NAMES.has(cleaned.toLowerCase())) return null;

  // Strip country prefix: "Deutschland, Grefrath" → "Grefrath"
  const commaMatch = cleaned.match(/^(?:Deutschland|Italien|Frankreich|Spanien|Schweiz|Österreich|Germany|Italy|France|Spain|Switzerland|Austria|Oesterreich|Dänemark|Denmark|Polen|Poland|Ungarn|Hungary|Tschechien|Niederlande|Netherlands|Belgien|Belgium),?\s*(.+)$/i);
  if (commaMatch) cleaned = commaMatch[1].trim();

  // Strip ICAO code suffix: "Kapfenberg LOGK" → "Kapfenberg"
  const icaoMatch = cleaned.match(/^(.+?)\s+([A-Z]{4})$/);
  if (icaoMatch && isValidIcaoCode(icaoMatch[2])) {
    cleaned = icaoMatch[1].trim();
  }

  // Strip ICAO in parentheses: "München (EDDM)" → "München"
  cleaned = cleaned.replace(/\s*\([A-Z]{4}\)\s*/g, "").trim();
  // Strip ICAO after slash: "Strausberg/EDAY" → "Strausberg"
  cleaned = cleaned.replace(/\/[A-Z]{4}$/, "").trim();

  // Strip airport/location prefixes
  cleaned = cleaned.replace(/^(?:Flugplatz|Flughafen|Airport|Airfield|Standort|Raum|Region|Nähe|bei|near|in)\s+/i, "").trim();

  // Strip trailing garbage keywords
  cleaned = cleaned.replace(/\s+(?:Lagerung|Hangar|Unfall|Werkstatt|Museum|Privatverkauf|Verkauf|Baujahr|BJ|Motor|Rotax|Standort|Flugplatz|Flughafen|southwest|northwest|northeast|southeast|NM|km|Stunden|Betriebsstunden).*$/i, "").trim();

  // Strip postal codes: "86150 Augsburg" → "Augsburg"
  cleaned = cleaned.replace(/^\d{4,5}\s+/, "").trim();

  // Strip "15NM southwest of Bremen, Germany" patterns
  cleaned = cleaned.replace(/^\d+\s*NM\s+\w+\s+(?:of|von)\s+/i, "").trim();

  // Strip "nähe von Amsterdam" → "Amsterdam"
  cleaned = cleaned.replace(/^nähe\s+(?:von\s+)?/i, "").trim();

  // Take only first part before comma (city, not description)
  if (cleaned.includes(",")) {
    cleaned = cleaned.split(",")[0].trim();
  }

  // Reject if any word is in the invalid set
  const words = cleaned.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (INVALID_CITY_WORDS.has(word)) return null;
  }

  // Reject if city contains numbers (except hyphenated like "Bad-1" which doesn't exist)
  if (/\d/.test(cleaned)) return null;

  // Reject city names that are too long (real cities are max ~30 chars)
  if (cleaned.length < 2 || cleaned.length > 35) return null;

  // Reject if it looks like a sentence (more than 4 words)
  if (words.length > 4) return null;

  // Reject if it starts with a lowercase letter (not a proper noun)
  if (/^[a-zäöü]/.test(cleaned)) return null;

  return cleaned;
}

function cleanCountry(country: string | null): string | null {
  if (!country) return null;
  const lower = country.trim().toLowerCase();
  if (COUNTRY_MAP[lower]) return COUNTRY_MAP[lower];
  if (COUNTRY_NAMES.has(lower)) return country.trim();
  return country.trim();
}

/**
 * Detect country from aircraft registration prefix.
 * Source: https://de.wikipedia.org/wiki/Luftfahrzeugkennzeichen
 * Returns English country name or null if unknown.
 */
function countryFromRegistration(registration: string | null): string | null {
  if (!registration) return null;
  const reg = registration.toUpperCase().replace(/\s+/g, "");

  // European countries (most relevant for TradeAero marketplace)
  if (reg.startsWith("D-")) return "Germany";
  if (reg.startsWith("OE-")) return "Austria";
  if (reg.startsWith("HB-")) return "Switzerland";
  if (reg.startsWith("F-")) return "France";
  if (reg.startsWith("G-")) return "United Kingdom";
  if (reg.startsWith("I-")) return "Italy";
  if (reg.startsWith("EC-")) return "Spain";
  if (reg.startsWith("PH-")) return "Netherlands";
  if (reg.startsWith("OO-")) return "Belgium";
  if (reg.startsWith("SP-")) return "Poland";
  if (reg.startsWith("OK-")) return "Czech Republic";
  if (reg.startsWith("SE-")) return "Sweden";
  if (reg.startsWith("LN-")) return "Norway";
  if (reg.startsWith("OY-")) return "Denmark";
  if (reg.startsWith("OH-")) return "Finland";
  if (reg.startsWith("SX-")) return "Greece";
  if (reg.startsWith("TC-")) return "Turkey";
  if (reg.startsWith("HA-")) return "Hungary";
  if (reg.startsWith("YR-")) return "Romania";
  if (reg.startsWith("9A-")) return "Croatia";
  if (reg.startsWith("OM-")) return "Slovakia";
  if (reg.startsWith("S5-")) return "Slovenia";
  if (reg.startsWith("LZ-")) return "Bulgaria";
  if (reg.startsWith("EI-") || reg.startsWith("EJ-")) return "Ireland";
  if (reg.startsWith("TF-")) return "Iceland";
  if (reg.startsWith("ES-")) return "Estonia";
  if (reg.startsWith("YL-")) return "Latvia";
  if (reg.startsWith("LY-")) return "Lithuania";
  if (reg.startsWith("LX-")) return "Luxembourg";
  if (reg.startsWith("9H-")) return "Malta";
  if (reg.startsWith("CS-") || reg.startsWith("CR-")) return "Portugal";
  if (reg.startsWith("UR-")) return "Ukraine";

  // Non-European (common in international market)
  if (reg.startsWith("N")) return "United States"; // N-numbers (no dash)
  if (reg.startsWith("C-") || reg.startsWith("CF-")) return "Canada";
  if (reg.startsWith("VH-")) return "Australia";
  if (reg.startsWith("ZK-") || reg.startsWith("ZL-") || reg.startsWith("ZM-")) return "New Zealand";
  if (reg.startsWith("ZS-") || reg.startsWith("ZT-") || reg.startsWith("ZU-")) return "South Africa";
  if (reg.startsWith("PP-") || reg.startsWith("PR-") || reg.startsWith("PT-") || reg.startsWith("PU-")) return "Brazil";
  if (reg.startsWith("JA-")) return "Japan";
  if (reg.startsWith("RA-") || reg.startsWith("RF-")) return "Russia";
  if (reg.startsWith("9V-")) return "Singapore";
  if (reg.startsWith("VT-")) return "India";
  if (reg.startsWith("B-")) return "China";

  return null;
}

/**
 * Validate ICAO airport code — must be exactly 4 uppercase letters
 * starting with a valid regional prefix.
 */
function isValidIcaoCode(code: string | null): boolean {
  if (!code) return false;
  if (!/^[A-Z]{4}$/.test(code)) return false;
  // Valid European/common regional prefixes
  return /^(ED|ET|LO|LS|LF|LE|LI|EH|EB|EP|LK|ES|EN|EK|LG|LT|LH|LR|LD|EG|EI|BI|EV|EY|EE|LJ|LM|LP|LC|LW|LN|LA|UK|UU|K|CY|PA|PH)/.test(code);
}

function cleanIcaoCode(code: string | null): string | null {
  if (!code) return null;
  const cleaned = code.trim().toUpperCase();
  return isValidIcaoCode(cleaned) ? cleaned : null;
}

/**
 * Auto-resolve state/province from city + country using the reference tables.
 * Caches the lookup data on first call.
 */
let locationCache: Map<string, { state: string | null; countryName: string }> | null = null;

async function loadLocationCache(): Promise<Map<string, { state: string | null; countryName: string }>> {
  if (locationCache) return locationCache;
  locationCache = new Map();

  const { data: cities } = await supabase
    .from("cities")
    .select("name, country_id, state_id, countries(name), states(name)");

  if (cities) {
    for (const c of cities as any[]) {
      const cityName = (c.name ?? "").toLowerCase();
      const countryName = c.countries?.name ?? "";
      const stateName = c.states?.name ?? null;
      if (cityName && countryName) {
        locationCache.set(`${cityName}|${countryName.toLowerCase()}`, { state: stateName, countryName });
      }
    }
  }

  logger.info(`Loaded location cache: ${locationCache.size} city entries`);
  return locationCache;
}

async function resolveState(city: string | null, country: string | null): Promise<string | null> {
  if (!city || !country) return null;
  const cache = await loadLocationCache();
  const entry = cache.get(`${city.toLowerCase()}|${country.toLowerCase()}`);
  return entry?.state ?? null;
}

let categoryCache: Map<string, number> | null = null;
async function getCategoryId(name: string): Promise<number | null> {
  if (!categoryCache) {
    const { data } = await supabase.from("aircraft_categories").select("id, name");
    categoryCache = new Map((data ?? []).map((c: any) => [c.name.toLowerCase(), c.id]));
  }
  return categoryCache.get(name.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Main upsert
// ---------------------------------------------------------------------------

export async function upsertAircraftListing(
  listing: ParsedAircraftListing,
  systemUserId: string,
): Promise<"inserted" | "updated" | "skipped"> {
  try {
    logger.info(`Processing listing: ${listing.title}`);

    if (!listing.imageUrls || listing.imageUrls.length === 0) {
      logger.debug(`Skipping listing with no images: "${listing.title}"`);
      return "skipped";
    }

    if (!listing.year) {
      logger.debug(`Skipping listing with no year: "${listing.title}"`);
      return "skipped";
    }

    const cleanTitle = stripTitleDatePrefix(listing.title);

    const manufacturerName = await resolveManufacturer(cleanTitle);
    const manufacturerMap = await getManufacturerMap();
    const manufacturerId = manufacturerName
      ? (manufacturerMap.get(manufacturerName.toLowerCase()) ?? null) : null;

    const refSpecs = await lookupReferenceSpecs(cleanTitle, listing.description ?? "", listing.engine ?? null);

    // Extract clean model name from title (prefers reference spec match)
    let modelName = extractModelFromTitle(cleanTitle, manufacturerName, refSpecs as any);

    // Task 1 fallback (per docs/CRAWLER_HANDOVER_CATEGORY_MODEL_DEDUP.md):
    // When no ref-spec scored high enough to classify AND the extracted
    // model still looks like a raw headline fragment (too many words, too
    // long, or engine/garbage survived), scan the headline against all
    // ref-spec models for this manufacturer and pick the longest match.
    // This recovers clean names like "NG5" or "B23" when the headline is
    // polluted with spec dumps ("BRM Aero Bristell RG Bristell UL mit
    // Einziehfahrwerk, DynonAvionics SkyViewTouch Display").
    const modelLooksRaw = !(refSpecs as { ref_model?: string } | null)?.ref_model
      && (modelName.length === 0 || modelName.length > 40 ||
          modelName.split(/\s+/).length > 4 || !isCleanModel(modelName));
    if (modelLooksRaw) {
      const scanned = await scanHeadlineForKnownModel(cleanTitle, manufacturerName);
      if (scanned && scanned.length <= 80) {
        logger.info(
          `Model fallback via ref-spec headline scan: "${modelName.slice(0, 60)}" → "${scanned}" (manufacturer=${manufacturerName ?? "?"})`,
        );
        modelName = scanned;
      }
    }

    // Hard skip: if we STILL don't have a clean model after both the
    // extract step AND the ref-spec headline scan, there's no way to
    // produce a sensible manufacturer hub URL (/{type}/{manufacturer}/{model}/).
    // Prior versions fell back to a 60-char title slice here, which
    // pushed full headline sentences into aircraft_listings.model —
    // produced unclickable hub URLs and garbage "model" cards in search.
    // Better to skip the listing and let the admin seed the ref_spec or
    // the next parser revision recover it.
    if (!modelName || !isCleanModel(modelName)) {
      logger.warn(
        `Skipping listing "${cleanTitle.slice(0, 80)}" — no clean model could be extracted (manufacturer=${manufacturerName ?? "?"}, raw model="${modelName.slice(0, 40)}")`,
      );
      return "skipped";
    }

    const detectedCategoryName = await detectCategoryName(listing.sourceUrl, cleanTitle, manufacturerName, listing.registration);
    const categoryId = detectedCategoryName ? await getCategoryId(detectedCategoryName) : null;

    // Dedup
    const { data: existing } = await supabase
      .from("aircraft_listings")
      .select("id, is_external, claimed_at")
      .eq("source_url", listing.sourceId)
      .maybeSingle();

    // Skip-on-claim guard (§8c of COLD_EMAIL_CLAIM_CONCEPT.md).
    // Once a listing has been claimed by its original seller — via either
    // the cold-email /claim/[token] flow or the in-app /claim/external/
    // flow — the row's ownership has transferred to a real user. Re-running
    // the upsert would clobber their edits and flip is_external back to
    // true. Detect both flags for defence in depth: either being set is
    // sufficient to skip.
    if (existing && (existing.is_external === false || existing.claimed_at)) {
      logger.info(
        `Skipping claimed listing (source_url=${listing.sourceId}, is_external=${existing.is_external}, claimed_at=${existing.claimed_at ?? "null"})`,
      );
      return "skipped";
    }

    // Images (new listings only)
    const images = existing ? [] : await uploadImages(listing.imageUrls, cleanTitle, "aircraft-images");

    // Gate new listings on successful image upload. The earlier check at
    // listing.imageUrls.length verified the source had image URLs, but those
    // downloads can still fail (timeout, 403, invalid format, domain block).
    // A listing with zero successfully-uploaded images produces a broken
    // marketplace card and should be skipped, not inserted.
    if (!existing && images.length === 0) {
      logger.debug(`Skipping new listing — no images uploaded successfully: "${cleanTitle}"`);
      return "skipped";
    }

    // Extract structured data from description
    const extracted = await extractStructuredData(cleanTitle, listing.description ?? "");

    // Use cleaned description for translation (specs removed, deduplicated)
    const rawDesc = extracted?.cleaned_description ?? listing.description ?? "";
    let descForTranslation = deduplicateDescription(rawDesc);
    // Fallback: ensure description meets the 10-char minimum (description_check constraint)
    if (!descForTranslation || descForTranslation.trim().length < 10) {
      descForTranslation = listing.description && listing.description.trim().length >= 10
        ? listing.description
        : `${cleanTitle} — ${listing.year ?? ""}`.trim();
    }

    // Translations
    let translations: TranslationResult | null = null;
    if (process.env.ANTHROPIC_API_KEY && descForTranslation) {
      try {
        translations = await translateListing(cleanTitle, descForTranslation, "de");
      } catch (err) {
        logger.warn(`Translation failed for "${cleanTitle}": ${err}`);
      }
    }

    const localeFields = buildLocaleFields(cleanTitle, descForTranslation, translations);

    // Build record
    const record: Record<string, unknown> = {
      user_id: systemUserId,
      headline: cleanTitle,
      model: modelName,
      description: descForTranslation,
      year: listing.year,
      price: listing.price ?? 0,
      currency: "EUR",
      price_negotiable: listing.price ? listing.priceNegotiable : true,
      total_time: listing.totalTime ?? null,
      engine_hours: listing.engineHours ?? null,
      engine_type_name: listing.engine ?? null,
      location: listing.location ?? "",
      country: cleanCountry(listing.country) ?? countryFromRegistration(listing.registration) ?? "Germany",
      city: cleanCity(listing.city) ?? null,
      state: null as string | null,
      icaocode: cleanIcaoCode(listing.icaoCode) ?? null,
      registration: listing.registration ?? "",
      serial_number: listing.serialNumber ?? "",
      manufacturer_id: manufacturerId,
      category_id: categoryId,
      status: "active",
      source_name: listing.sourceName,
      source_url: listing.sourceId,
      is_external: true,
      // Audit flag that survives the claim flip. Set on every crawler INSERT
      // so the admin claim-% stat denominator (count(was_external=true)) =
      // "all listings that were ever external" — matching the intent of the
      // column, not just "already-claimed" rows.
      was_external: true,
      contact_name: listing.contactName ?? listing.sourceName,
      contact_email: listing.contactEmail ?? "noreply@trade.aero",
      contact_phone: listing.contactPhone ?? "",
      seats: "2",
      fuel_type: listing.fuelType ?? null,
      empty_weight: listing.emptyWeight ? String(listing.emptyWeight) : null,
      max_takeoff_weight: listing.maxTakeoffWeight ? String(listing.maxTakeoffWeight) : null,
      fuel_capacity: listing.fuelCapacity ? String(listing.fuelCapacity) : null,
      cruise_speed: listing.cruiseSpeed ? String(listing.cruiseSpeed) : null,
      max_speed: listing.maxSpeed ? String(listing.maxSpeed) : null,
      max_range: listing.maxRange ? String(listing.maxRange) : null,
      service_ceiling: listing.serviceCeiling ? String(listing.serviceCeiling) : null,
      auto_translate: false,
      headline_auto_translate: false,
      agree_to_terms: true,
      ...localeFields,
    };

    if (listing.avionicsText) record.avionics_other = listing.avionicsText;

    // Auto-resolve state/province from city + country reference tables
    const resolvedCity = record.city as string | null;
    const resolvedCountry = record.country as string | null;
    if (resolvedCity && resolvedCountry) {
      const state = await resolveState(resolvedCity, resolvedCountry);
      if (state) record.state = state;
    }

    // Apply extracted structured data (fills engine, avionics, equipment, etc.)
    if (extracted) applyExtractedData(record, extracted);

    // Apply reference specs (fills remaining missing performance data)
    if (refSpecs) applyReferenceSpecs(record, refSpecs);

    // Images
    if (images.length > 0) {
      record.images = images.map((img: any, idx: number) => {
        const enriched: Record<string, unknown> = {
          url: img.url, alt_text: img.alt_text || cleanTitle, auto_translate: false, sort_order: idx,
        };
        for (const lang of LANGS) {
          const t = translations?.[lang];
          enriched[`alt_text_${lang}`] = t?.headline ? `${t.headline} - Image ${idx + 1}` : `${cleanTitle} - Image ${idx + 1}`;
        }
        return enriched;
      });
    }

    // Upsert
    if (existing) {
      const updateFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (/^(headline|description|slug)_(en|de|fr|es|it|pl|cs|sv|nl|pt|ru|tr|el|no)$/.test(key)) continue;
        if (key === "slug" || key === "images") continue;
        // Never overwrite the claim audit flags on existing rows. `was_external`
        // was set on the original INSERT; `claimed_at` / `claimed_from_source`
        // are owner-controlled post-claim. The record scaffold only carries
        // these values for INSERTs.
        if (key === "was_external" || key === "claimed_at" || key === "claimed_from_source") continue;
        updateFields[key] = value;
      }
      // H2: atomic skip-on-claim guard. If the row was claimed between the
      // dedup SELECT (above) and this UPDATE, the `.eq("is_external", true)`
      // predicate makes the UPDATE a no-op instead of clobbering the
      // claimed listing. We also keep the earlier SELECT-based skip for the
      // common path (logs a clearer message, avoids a pointless UPDATE).
      const { error, data: updatedRows } = await supabase.from("aircraft_listings")
        .update({ ...updateFields, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .eq("is_external", true)
        .is("claimed_at", null)
        .select("id");
      if (error) { logger.error(`Failed to update aircraft "${cleanTitle}": ${error.message}`); return "skipped"; }
      if (!updatedRows || updatedRows.length === 0) {
        logger.info(`Skipped claimed aircraft id=${existing.id} title="${cleanTitle}" (raced with claim flow)`);
        return "skipped";
      }
      logger.info(`Updated aircraft id=${existing.id} title="${cleanTitle}"`);
      return "updated";
    }

    const { data: inserted, error } = await supabase.from("aircraft_listings")
      .insert(record).select("id, slug, listing_number").single();
    if (error) {
      const msg = error.message ?? "";
      // Benign errors: DB check constraints, and the Task-3 unique-source_url
      // index firing because a concurrent crawl already inserted this row.
      // Neither is a bug worth paging on; skip the listing and move on.
      const benign =
        msg.includes("check constraint") ||
        msg.includes("duplicate key") ||
        msg.includes("source_url_unique");
      const level = benign ? "warn" : "error";
      logger[level](`Failed to insert aircraft "${cleanTitle}": ${error.message}`);
      return "skipped";
    }

    // Localized slugs
    const listingNum = (inserted as any).listing_number ?? null;
    if (listingNum && translations) {
      const slugUpdate: Record<string, string> = {};
      if ((inserted as any).slug) slugUpdate.slug_en = (inserted as any).slug;
      for (const lang of LANGS) {
        if (lang === "en") continue;
        const hl = (record as Record<string, unknown>)[`headline_${lang}`];
        if (hl && typeof hl === "string" && hl.trim()) slugUpdate[`slug_${lang}`] = generateSlug(hl, listingNum);
      }
      if (Object.keys(slugUpdate).length > 0)
        await supabase.from("aircraft_listings").update(slugUpdate).eq("id", (inserted as any).id);
    }

    logger.info(`Inserted aircraft id=${(inserted as any).id} title="${cleanTitle}"`);

    // Queue claim-invite candidate for sources with sendColdEmailInvite=true.
    // Never blocks or fails the crawl; surface errors in the helper's logger.
    await enqueueInviteCandidate({
      listingId: (inserted as any).id,
      listingType: "aircraft",
      contactEmail: listing.contactEmail,
      sourceName: listing.sourceName,
    });

    if (manufacturerName) await seedReferenceEntry(manufacturerName, cleanTitle);
    return "inserted";
  } catch (err) {
    logger.error(`Unexpected error in upsertAircraftListing: ${err}`);
    return "skipped";
  }
}

export const upsertAircraft = upsertAircraftListing;
export { LANGS };

export async function ensureManufacturer(name: string): Promise<number | null> {
  try {
    const map = await getManufacturerMap();
    const cached = map.get(name.toLowerCase());
    if (cached !== undefined) return cached;
    const { data, error } = await supabase.from("aircraft_manufacturers")
      .upsert({ name }, { onConflict: "name" }).select("id").single();
    if (error || !data) { logger.warn(`Failed to ensure manufacturer "${name}": ${error?.message}`); return null; }
    map.set(name.toLowerCase(), data.id);
    return data.id;
  } catch (err) { logger.warn(`Error ensuring manufacturer "${name}": ${err}`); return null; }
}

async function seedReferenceEntry(manufacturer: string, title: string): Promise<void> {
  try {
    const model = title.replace(new RegExp(manufacturer, "i"), "").trim().slice(0, 100) || "Unknown";

    // Don't seed polluted models into aircraft_reference_specs. Without
    // this guard, an engine string / German filler / headline dump
    // extracted for `model` (see isCleanModel blacklist) would upsert
    // a ghost ref-spec row — those surface on manufacturer hub pages as
    // "Popular Models" cards with [0] listings and even become
    // browseable model-hub URLs. Refactor-repo migration
    // 20260421_purge_polluted_aircraft_reference_specs.sql cleans up
    // existing damage; this check prevents further pollution.
    if (!isCleanModel(model)) {
      logger.debug(
        `Skipped seedReferenceEntry — model looks polluted: "${model.slice(0, 60)}" (manufacturer=${manufacturer})`,
      );
      return;
    }

    await (supabase as any).from("aircraft_reference_specs")
      .upsert({ manufacturer, model, variant: null, notes: `Auto-seeded: "${title.slice(0, 200)}"` },
        { onConflict: "manufacturer,model,variant", ignoreDuplicates: true });
  } catch { /* non-critical */ }
}
