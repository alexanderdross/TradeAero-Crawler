import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  geocode,
  geocodeCacheKey,
  normalizeCountry,
  _resetGeocodeCacheForTests,
} from "../utils/geocode.js";

// ─────────────────────────────────────────────────────────────────────────────
// Geocode hardening contract.
//
// Pin behaviour around the new cache, country normalization, and retry
// logic. We mock global.fetch so tests are deterministic and don't hit
// the real Nominatim service (which would be flaky + against their TOS
// to spam from CI).
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetGeocodeCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => impl()),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeCountry", () => {
  it("returns ISO codes verbatim (uppercased)", () => {
    expect(normalizeCountry("de")).toBe("DE");
    expect(normalizeCountry("DE")).toBe("DE");
  });

  it("maps common English country names to ISO codes", () => {
    expect(normalizeCountry("Germany")).toBe("DE");
    expect(normalizeCountry("United Kingdom")).toBe("GB");
    expect(normalizeCountry("United States")).toBe("US");
  });

  it("maps native-name spellings (Deutschland, España, Türkiye)", () => {
    expect(normalizeCountry("Deutschland")).toBe("DE");
    expect(normalizeCountry("España")).toBe("ES");
    expect(normalizeCountry("Türkiye")).toBe("TR");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeCountry(" GERMANY ")).toBe("DE");
    expect(normalizeCountry("\tunited states\t")).toBe("US");
  });

  it("returns null for unknown names", () => {
    expect(normalizeCountry("Atlantis")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry("   ")).toBeNull();
  });
});

describe("geocodeCacheKey", () => {
  it("collapses case + whitespace differences", () => {
    expect(
      geocodeCacheKey({ venue: " Berlin ", city: "BERLIN", country: "DE" }),
    ).toBe(geocodeCacheKey({ venue: "berlin", city: "berlin", country: "de" }));
  });

  it("treats country name + ISO equivalently", () => {
    expect(
      geocodeCacheKey({ city: "Berlin", country: "Germany" }),
    ).toBe(geocodeCacheKey({ city: "Berlin", country: "DE" }));
  });

  it("uppercases ICAO", () => {
    expect(geocodeCacheKey({ icao: "edxx" })).toBe(
      geocodeCacheKey({ icao: "EDXX" }),
    );
  });
});

describe("geocode — cache", () => {
  it("returns cached success without re-querying Nominatim", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([{ lat: "52.5", lon: "13.4" }]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const args = { city: "Berlin", country: "DE" };
    const a = await geocode(args);
    const b = await geocode(args);
    expect(a).toEqual({ lat: 52.5, lon: 13.4 });
    expect(b).toEqual({ lat: 52.5, lon: 13.4 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("caches null misses too — same query never re-hits Nominatim", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    const args = { city: "Atlantis" };
    const a = await geocode(args);
    const b = await geocode(args);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats Germany and DE as the same cache key", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([{ lat: "52.5", lon: "13.4" }]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await geocode({ city: "Berlin", country: "Germany" });
    await geocode({ city: "Berlin", country: "DE" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("geocode — input validation", () => {
  it("returns null when no city/venue/icao is supplied", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await geocode({ country: "DE" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when GEOCODE_DISABLED=true", async () => {
    const prev = process.env.GEOCODE_DISABLED;
    process.env.GEOCODE_DISABLED = "true";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      expect(await geocode({ city: "Berlin" })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.GEOCODE_DISABLED;
      else process.env.GEOCODE_DISABLED = prev;
    }
  });

  it("rejects out-of-range coordinates from Nominatim", async () => {
    mockFetch(() => jsonResponse([{ lat: "999", lon: "13.4" }]));
    expect(await geocode({ city: "Bogus" })).toBeNull();
  });
});

describe("geocode — country code in query", () => {
  it("forwards the ISO country code as `countrycodes`", async () => {
    let captured: URL | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        captured = new URL(url);
        return jsonResponse([{ lat: "52.5", lon: "13.4" }]);
      }),
    );
    await geocode({ city: "Berlin", country: "Germany" });
    expect(captured).not.toBeNull();
    expect(captured!.searchParams.get("countrycodes")).toBe("de");
  });

  it("omits `countrycodes` when the country name doesn't normalize", async () => {
    let captured: URL | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        captured = new URL(url);
        return jsonResponse([{ lat: "0", lon: "0" }]);
      }),
    );
    await geocode({ city: "Somewhere", country: "Atlantis" });
    expect(captured).not.toBeNull();
    expect(captured!.searchParams.has("countrycodes")).toBe(false);
  });
});

describe("geocode — retry on 429/503", () => {
  it("retries on 429 then returns the success on attempt 2", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response("rate limited", { status: 429 });
        return jsonResponse([{ lat: "52.5", lon: "13.4" }]);
      }),
    );
    const out = await geocode({ city: "Berlin", country: "DE" });
    expect(calls).toBe(2);
    expect(out).toEqual({ lat: 52.5, lon: 13.4 });
  }, 15000);

  it("gives up after MAX_ATTEMPTS and caches the null result", async () => {
    const fetchSpy = vi.fn(
      async () => new Response("svc unavail", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const a = await geocode({ city: "Berlin", country: "DE" });
    expect(a).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Subsequent identical lookups should NOT hit fetch again — the
    // null result is cached.
    const b = await geocode({ city: "Berlin", country: "DE" });
    expect(b).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 20000);

  it("does not retry on a 4xx that isn't 429", async () => {
    const fetchSpy = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await geocode({ city: "Berlin" });
    expect(out).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
