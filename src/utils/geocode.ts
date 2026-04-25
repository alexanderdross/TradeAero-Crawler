import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Nominatim geocoder.
//
// Free OpenStreetMap-backed reverse geocoding. Used by the events pipeline
// to fill `latitude`/`longitude` for rows whose source didn't ship coords
// (Vereinsflieger, most ICS feeds). Coords unlock the map view, the
// "events near me" filter, and stronger Schema.org Place markup with
// GeoCoordinates.
//
// Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
//   - Max 1 request/second
//   - Identifying User-Agent required
//   - Cache results — do NOT re-query the same address
//
// We honour the rate limit via a process-global timestamp + sleep. Caching
// happens implicitly at the DB level — once a row has lat/lng populated we
// never geocode it again (upsertEvent only runs geocode when the column
// is null on an INSERT).
// ─────────────────────────────────────────────────────────────────────────────

const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  "TradeAero-Crawler/1.0 (+https://trade.aero; ops@trade.aero)";

// Process-global gate. Crude but sufficient — geocoding is single-threaded
// inside one crawler run, and parallel runs are unusual.
//
// Parallelism caveat: this counter is module-scoped, so two crawler
// processes running concurrently (e.g. someone manually firing two
// GitHub Action workflows that both reach this code) would NOT
// coordinate and could exceed Nominatim's 1 req/s policy. The
// existing GitHub Actions cron schedule explicitly staggers source
// runs (see `.github/workflows/crawl-*.yml`) so cross-process
// contention isn't a current concern. If the crawler ever fans out
// into Workers / parallel runs, swap this for a Redis token bucket.
let lastRequestMs = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastRequestMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestMs = Date.now();
}

interface NominatimHit {
  lat: string;
  lon: string;
  /** Confidence-ish: lower = better match */
  importance?: number;
  display_name?: string;
}

interface GeocodeArgs {
  /** Free-text venue name (e.g. "Stuttgart Airport, Terminal 3") */
  venue?: string | null;
  /** City name */
  city?: string | null;
  /** ISO 3166-1 alpha-2 country code OR full name */
  country?: string | null;
  /** Optional ICAO (gives better hits when present) */
  icao?: string | null;
}

/**
 * Geocode a venue/city/country triple to (lat, lon) via Nominatim.
 *
 * Returns null when:
 *   - GEOCODE_DISABLED env var is "true" (escape hatch for prod outages)
 *   - the input is too sparse (need at least a city or venue)
 *   - Nominatim returns 0 hits
 *   - the request fails (network, timeout, 429)
 *
 * The caller should treat null as "unknown" and skip writing lat/lng —
 * never as a hard failure.
 */
export async function geocode(
  args: GeocodeArgs,
): Promise<{ lat: number; lon: number } | null> {
  if (process.env.GEOCODE_DISABLED === "true") return null;

  const parts = [args.venue, args.icao, args.city, args.country]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  // Need at least venue or city — country alone is too coarse to be useful.
  if (!args.venue && !args.city && !args.icao) return null;

  const query = parts.join(", ");
  await rateLimit();

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "0");
    url.searchParams.set("q", query);
    // Country code biases results when present.
    if (args.country && /^[a-z]{2}$/i.test(args.country)) {
      url.searchParams.set("countrycodes", args.country.toLowerCase());
    }

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": NOMINATIM_USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      logger.warn("Nominatim non-OK response", { status: res.status, query });
      return null;
    }
    const data = (await res.json()) as NominatimHit[];
    if (!Array.isArray(data) || data.length === 0) return null;
    const hit = data[0];
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    logger.debug("Nominatim geocoded", { query, lat, lon });
    return { lat, lon };
  } catch (err) {
    logger.warn("Nominatim geocode failed", {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
