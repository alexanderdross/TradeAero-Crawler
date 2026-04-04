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
  /** Total flight hours */
  totalTime: number | null;
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
  /** Contact name */
  contactName: string | null;
  /** Contact email (deobfuscated) */
  contactEmail: string | null;
  /** Contact phone */
  contactPhone: string | null;
  /** Image URLs (absolute) */
  imageUrls: string[];
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

/** Result of a single crawl run */
export interface CrawlResult {
  runId: string;
  source: string;
  target: "aircraft" | "parts";
  startedAt: string;
  completedAt: string;
  pagesProcessed: number;
  listingsFound: number;
  listingsInserted: number;
  listingsUpdated: number;
  listingsSkipped: number;
  errors: string[];
}
