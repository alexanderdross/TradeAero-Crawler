/**
 * Shared types for the TradeAero crawler.
 * These represent the intermediate parsed format before mapping to Supabase schema.
 */

/** Raw parsed aircraft listing from Helmut's UL Seiten */
export interface ParsedAircraftListing {
  /** Stable identifier for deduplication: pageUrl#index@date */
  sourceId: string;
  /** Full URL of the source page */
  sourceUrl: string;
  /** Source website name */
  sourceName: string;
  /** Date the listing was posted (ISO format) */
  postedDate: string | null;
  /** Listing title / aircraft name */
  title: string;
  /** Full description text */
  description: string;
  /** Year of manufacture */
  year: number | null;
  /** Engine description (e.g., "Rotax 912ULS 100 PS") */
  engine: string | null;
  /** Total airframe flight hours (TTAF) */
  totalTime: number | null;
  /** Engine hours (TTSN / Motorstunden) */
  engineHours: number | null;
  /** Number of landings / cycles */
  cycles: number | null;
  /** Maximum takeoff weight in kg */
  mtow: number | null;
  /** Rescue system description */
  rescueSystem: string | null;
  /** Annual inspection date (Jahresnachprüfung) */
  annualInspection: string | null;
  /** DULV certification reference */
  dulvRef: string | null;
  /** Price in EUR */
  price: number | null;
  /** Whether price is negotiable */
  priceNegotiable: boolean;
  /** Location / region */
  location: string | null;
  /** Extracted city name */
  city: string | null;
  /** Airfield / airport name */
  airfieldName: string | null;
  /** ICAO airport code (e.g., EDAZ) */
  icaoCode: string | null;
  /** Aircraft registration mark (e.g., D-MSEW, HB-YGX) */
  registration: string | null;
  /** Serial / Werk-Nr. */
  serialNumber: string | null;
  /** Whether the aircraft is airworthy (from explicit text mention) */
  airworthy: boolean | null;
  /** Free-text avionics description (GPS, radios, transponder, etc.) */
  avionicsText: string | null;
  /** Country of the aircraft (null = assume Germany) */
  country: string | null;
  /** Empty weight in kg (Leergewicht / Leermasse) */
  emptyWeight: number | null;
  /** Max takeoff weight in kg (from structured field, complements mtow) */
  maxTakeoffWeight: number | null;
  /** Fuel capacity in litres (Tankinhalt) */
  fuelCapacity: number | null;
  /** Fuel type (MOGAS, AVGAS, Jet-A, etc.) */
  fuelType: string | null;
  /** Cruise speed in km/h (Reisegeschwindigkeit) */
  cruiseSpeed: number | null;
  /** Max speed in km/h (Höchstgeschwindigkeit / Vne) */
  maxSpeed: number | null;
  /** Max range in km (Reichweite) */
  maxRange: number | null;
  /** Service ceiling in m (Gipfelhöhe) */
  serviceCeiling: number | null;
  /** Climb rate in m/s (Steigleistung) */
  climbRate: number | null;
  /** Fuel consumption in L/h (Verbrauch) */
  fuelConsumption: number | null;
  /** Contact name */
  contactName: string | null;
  /** Contact email (deobfuscated) */
  contactEmail: string | null;
  /** Contact phone */
  contactPhone: string | null;
  /** Image URLs (absolute) */
  imageUrls: string[];
  /**
   * Optional manufacturer hint extracted from the source URL or page context
   * (e.g. aircraft24 URL path: /singleprop/diamond/... → "diamond").
   * Passed to resolveManufacturer() to improve matching accuracy.
   */
  manufacturerHint?: string;
  /**
   * Optional category override from the source URL segment
   * (e.g. aircraft24 URL: /singleprop/... → "Single Engine Piston").
   * When present, bypasses keyword-based detectCategoryName() entirely.
   */
  categoryHint?: string;
}

/** Raw parsed parts listing from Helmut's UL Seiten */
export interface ParsedPartsListing {
  sourceId: string;
  sourceUrl: string;
  sourceName: string;
  postedDate: string | null;
  title: string;
  description: string;
  /** Inferred category */
  category: "avionics" | "engines" | "propellers" | "instruments" | "rescue" | "miscellaneous";
  /** Operating hours / TTSN */
  totalTime: number | null;
  /** Condition description */
  condition: string | null;
  price: number | null;
  priceNegotiable: boolean;
  /** VAT status */
  vatIncluded: boolean | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  imageUrls: string[];
  location: string | null;
}

/**
 * Parsed aviation event — one row per public-calendar entry on
 * vereinsflieger.de. Mirrors the conventions of ParsedAircraftListing:
 * intermediate shape before mapping to the aviation_events schema.
 */
export interface ParsedEvent {
  /** Stable dedup key: `${pageUrl}#${sha1(title|startISO|organizer)}` */
  sourceId: string;
  /** Same as sourceId — persisted to aviation_events.source_url */
  sourceUrl: string;
  /** Source website name, e.g. "vereinsflieger.de" */
  sourceName: string;
  /** Source page URL (used as referer context) */
  pageUrl: string;
  /** Vereinsflieger source category 1..6 (for audit/debug only) */
  sourceCategoryId: number;
  /** Mapped event_categories.code (seminar, competition, ...) */
  categoryCode: string;

  /** Event title, raw German */
  title: string;
  /** Sub-/type line (e.g. "Seminar - Fortbildung") */
  subtitle: string | null;
  /** Source "24.04.2026" / "24.04.2026 - 26.04.2026" string, preserved for description */
  dateRangeText: string | null;

  /** Start/end in ISO 8601 (UTC). Both are midnight of the calendar day. */
  startDate: string;
  endDate: string;
  /** IANA timezone — always 'Europe/Berlin' for this source */
  timezone: string;

  /** ISO 3166-1 alpha-2 country code — always 'DE' for this source */
  country: string;
  /** Best-effort city extraction from venue text */
  city: string | null;
  /** Venue name with trailing `(EDXX)` stripped */
  venueName: string;
  /** Extracted from venue text via `/\(([A-Z]{4})\)/`; nullable */
  icaoCode: string | null;

  /** Organiser club / Verband name */
  organizerName: string;

  /** Optional long-form description. Vereinsflieger has none — synthesized
   *  in the parser. ICS sources carry the SUMMARY/DESCRIPTION pair. */
  description?: string | null;
  /** Optional canonical event URL (e.g. organiser's event page). Used for
   *  the "More details" link on the detail page. */
  eventUrl?: string | null;
  /** Optional geographic coordinates. Crawlers that have them populate
   *  here; rows without coords get geocoded by upsertEvent via Nominatim. */
  latitude?: number | null;
  longitude?: number | null;
  /** ISO 639-1 source language. Drives the translator's source-side and
   *  defaults to "de" for legacy compatibility (Vereinsflieger). ICS feeds
   *  set "en" by default — calendars can override per source. */
  sourceLocale?: string;
}

/** Result of a single crawl run */
export interface CrawlResult {
  runId: string;
  source: string;
  target: "aircraft" | "parts" | "events";
  startedAt: string;
  completedAt: string;
  pagesProcessed: number;
  listingsFound: number;
  listingsInserted: number;
  listingsUpdated: number;
  listingsSkipped: number;
  errors: string[];
}
