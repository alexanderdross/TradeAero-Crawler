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
// Strategy
//   - Process-global rate limiter (1 req/s).
//   - Process-global memo cache for both successful AND null results.
//     A single feed often has 50+ events at the same venue ("EAA Chapter
//     245, Hamilton OH") — without caching every one of those would hit
//     Nominatim and burn 50+ seconds of rate-limited time per run.
//   - Country name → ISO 3166-1 alpha-2 normalization so config entries
//     can use either the human name or the code interchangeably.
//   - Bounded retry on 429 / 503 with exponential backoff. Persistent
//     issues still soft-fail (caller sees null, no abort).
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

export interface GeocodeArgs {
  /** Free-text venue name (e.g. "Stuttgart Airport, Terminal 3") */
  venue?: string | null;
  /** City name */
  city?: string | null;
  /** ISO 3166-1 alpha-2 country code OR full English name */
  country?: string | null;
  /** Optional ICAO (gives better hits when present) */
  icao?: string | null;
}

export interface GeocodeResult {
  lat: number;
  lon: number;
}

// Common country names → ISO 3166-1 alpha-2. Covers the names the
// crawler config + parsers actually emit (Vereinsflieger sets
// `defaultCountry: "Germany"`; ICS calendars use whatever the operator
// pasted in). Extend as new sources land.
const COUNTRY_TO_ISO: Record<string, string> = {
  "germany": "DE",
  "deutschland": "DE",
  "austria": "AT",
  "österreich": "AT",
  "switzerland": "CH",
  "schweiz": "CH",
  "france": "FR",
  "italy": "IT",
  "italia": "IT",
  "spain": "ES",
  "españa": "ES",
  "poland": "PL",
  "polska": "PL",
  "czech republic": "CZ",
  "czechia": "CZ",
  "sweden": "SE",
  "netherlands": "NL",
  "portugal": "PT",
  "russia": "RU",
  "turkey": "TR",
  "türkiye": "TR",
  "greece": "GR",
  "norway": "NO",
  "united kingdom": "GB",
  "uk": "GB",
  "great britain": "GB",
  "united states": "US",
  "usa": "US",
  "united states of america": "US",
  "canada": "CA",
};

/**
 * Resolve a country argument (ISO code or English/native name) to an
 * ISO 3166-1 alpha-2 code suitable for Nominatim's `countrycodes`
 * parameter. Returns null when the input doesn't match any known
 * mapping; the caller should still pass the raw string through to
 * Nominatim's `q` so the geocoder can use it as a free-text hint.
 */
export function normalizeCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  const trimmed = country.trim();
  if (!trimmed) return null;
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  const iso = COUNTRY_TO_ISO[trimmed.toLowerCase()];
  return iso ?? null;
}

/**
 * Build the cache key for a geocode args triple. Lower-cased and
 * trimmed so "Berlin" and " berlin " collide; ICAO + country code are
 * canonicalised to upper-case for the same reason.
 */
export function geocodeCacheKey(args: GeocodeArgs): string {
  const venue = (args.venue ?? "").trim().toLowerCase();
  const city = (args.city ?? "").trim().toLowerCase();
  const icao = (args.icao ?? "").trim().toUpperCase();
  const country = (normalizeCountry(args.country) ?? args.country ?? "")
    .trim()
    .toUpperCase();
  return `${venue}|${city}|${icao}|${country}`;
}

// Module-scoped cache. Holds GeocodeResult on success or null on a
// confirmed miss; both forms short-circuit subsequent identical
// queries within the same process.
const cache = new Map<string, GeocodeResult | null>();

/** Test-only: drop the cache between specs so they don't bleed state. */
export function _resetGeocodeCacheForTests(): void {
  cache.clear();
  lastRequestMs = 0;
}

const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;

/**
 * Geocode a venue/city/country triple to (lat, lon) via Nominatim.
 *
 * Returns null when:
 *   - GEOCODE_DISABLED env var is "true" (escape hatch for prod outages)
 *   - the input is too sparse (need at least a city or venue)
 *   - Nominatim returns 0 hits
 *   - the request fails (network, timeout, 429 after retries)
 *
 * Successful AND null results are cached for the lifetime of the
 * process so the same venue triple never re-hits Nominatim within one
 * crawler run.
 *
 * The caller should treat null as "unknown" and skip writing lat/lng —
 * never as a hard failure.
 */
export async function geocode(
  args: GeocodeArgs,
): Promise<GeocodeResult | null> {
  if (process.env.GEOCODE_DISABLED === "true") return null;

  const parts = [args.venue, args.icao, args.city, args.country]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  // Need at least venue or city — country alone is too coarse to be useful.
  if (!args.venue && !args.city && !args.icao) return null;

  // Cache-hit early exit (covers both successes and null misses).
  const key = geocodeCacheKey(args);
  if (cache.has(key)) return cache.get(key) ?? null;

  const query = parts.join(", ");
  const isoCountry = normalizeCountry(args.country);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await rateLimit();
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1");
      url.searchParams.set("addressdetails", "0");
      url.searchParams.set("q", query);
      if (isoCountry) {
        url.searchParams.set("countrycodes", isoCountry.toLowerCase());
      }

      const res = await fetch(url.toString(), {
        headers: {
          "User-Agent": NOMINATIM_USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        // Retryable transient — back off and try again.
        if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          logger.warn("Nominatim transient response, retrying", {
            status: res.status,
            attempt,
            backoffMs,
            query,
          });
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        logger.warn("Nominatim non-OK response", { status: res.status, query });
        cache.set(key, null);
        return null;
      }
      const data = (await res.json()) as NominatimHit[];
      if (!Array.isArray(data) || data.length === 0) {
        cache.set(key, null);
        return null;
      }
      const hit = data[0];
      const lat = Number(hit.lat);
      const lon = Number(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        cache.set(key, null);
        return null;
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        cache.set(key, null);
        return null;
      }
      const result = { lat, lon };
      cache.set(key, result);
      logger.debug("Nominatim geocoded", { query, lat, lon });
      return result;
    } catch (err) {
      // AbortError (timeout) and network failures are retried up to
      // MAX_ATTEMPTS; the final failure caches null so we don't keep
      // hammering an unreachable host within the same run.
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        logger.warn("Nominatim request failed, retrying", {
          query,
          attempt,
          backoffMs,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      logger.warn("Nominatim geocode failed", {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      cache.set(key, null);
      return null;
    }
  }
  // Exhausted retries without producing a return — defensive fallback.
  cache.set(key, null);
  return null;
}
