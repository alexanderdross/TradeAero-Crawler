import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock that all tests configure via mockImplementation
// ---------------------------------------------------------------------------

const mockFrom = vi.fn();

vi.mock("../db/client.js", () => ({
  supabase: { from: mockFrom },
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockUploadImages = vi.fn();
vi.mock("../utils/images.js", () => ({
  uploadImages: mockUploadImages,
}));

vi.mock("../utils/translate.js", () => ({
  translateListing: vi.fn().mockResolvedValue(null),
}));

vi.mock("../utils/extract.js", () => ({
  extractStructuredData: vi.fn().mockResolvedValue(null),
  applyExtractedData: vi.fn(),
  deduplicateDescription: vi.fn().mockImplementation((text: string) => text),
}));

vi.mock("../parsers/shared.js", () => ({
  stripTitleDatePrefix: vi.fn().mockImplementation((title: string) =>
    title.replace(/^\d{1,2}\.\d{1,2}\.\d{4}\s+/, "")
  ),
}));

vi.mock("../db/reference-specs.js", () => ({
  lookupReferenceSpecs: vi.fn().mockResolvedValue(null),
  applyReferenceSpecs: vi.fn(),
  lookupCategoryFromRefSpecs: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock for aircraft_listings table with configurable dedup + insert/update results.
 *  The `existing` row carries is_external + claimed_at so skip-on-claim tests can
 *  simulate claimed rows; the UPDATE chain terminates in `.select()` so the
 *  atomic .eq("is_external", true).is("claimed_at", null) guard is testable. */
function listingsMock(opts: {
  existing?:
    | { id: string; is_external?: boolean; claimed_at?: string | null }
    | null;
  insertResult?: { data: any; error: any };
  updateError?: any;
  /** Simulate the atomic-guard no-op: UPDATE matched the WHERE but the
   *  is_external/claimed_at predicate filtered it out. Returns empty data. */
  updateFilteredOut?: boolean;
}) {
  const updateChain: any = {
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({
      data: opts.updateFilteredOut
        ? []
        : [{ id: opts.existing?.id ?? "existing-id" }],
      error: opts.updateError ?? null,
    }),
  };
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: opts.existing ?? null,
          error: null,
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue(
          opts.insertResult ?? {
            data: { id: "new-id", slug: "slug", listing_number: 100 },
            error: null,
          },
        ),
      }),
    }),
    update: vi.fn().mockReturnValue(updateChain),
  };
}

function setupMockFrom(opts: {
  refSpecManufacturers?: string[];
  manufacturers?: { id: number; name: string }[];
  existing?:
    | { id: string; is_external?: boolean; claimed_at?: string | null }
    | null;
  insertResult?: { data: any; error: any };
  updateError?: any;
  updateFilteredOut?: boolean;
  captureInsert?: (rec: any) => void;
}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "aircraft_reference_specs") {
      return {
        select: () => ({
          data: (opts.refSpecManufacturers ?? []).map((m) => ({ manufacturer: m })),
          error: null,
        }),
        upsert: () => ({ data: null, error: null }),
      };
    }
    if (table === "aircraft_manufacturers") {
      return {
        select: () => ({
          data: opts.manufacturers ?? [],
          error: null,
        }),
      };
    }
    if (table === "aircraft_categories") {
      return { select: () => ({ data: [], error: null }) };
    }
    if (table === "aircraft_listings") {
      const lm = listingsMock({
        existing: opts.existing ?? null,
        insertResult: opts.insertResult,
        updateError: opts.updateError,
        updateFilteredOut: opts.updateFilteredOut,
      });
      if (opts.captureInsert) {
        lm.insert = vi.fn().mockImplementation((rec: any) => {
          opts.captureInsert!(rec);
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue(
                opts.insertResult ?? {
                  data: { id: "new-id", slug: "slug", listing_number: 100 },
                  error: null,
                },
              ),
            }),
          };
        });
      }
      return lm;
    }
    // fallback
    return { select: () => ({ data: [], error: null }) };
  });
}

function makeListing(overrides: Record<string, any> = {}) {
  return {
    title: "Cessna 172",
    description: "Nice aircraft for sale",
    sourceId: "https://example.com/cessna-172",
    sourceName: "test-source",
    imageUrls: ["https://example.com/img.jpg"],
    year: 2020,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset module-level caches by re-importing fresh each time
  vi.resetModules();
  mockUploadImages.mockResolvedValue([]);
});

describe("dedup lookup", () => {
  it("updates existing listing instead of inserting", async () => {
    setupMockFrom({
      existing: { id: "existing-uuid-123", is_external: true, claimed_at: null },
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(makeListing(), "system-user-id");

    expect(result).toBe("updated");
  });
});

// Skip-on-claim guard (§8c of COLD_EMAIL_CLAIM_CONCEPT.md). Covers both
// layers: the early-exit SELECT and the atomic UPDATE predicate.
describe("skip-on-claim guard", () => {
  it("skips when existing row has is_external=false (claimed)", async () => {
    setupMockFrom({
      existing: {
        id: "claimed-uuid",
        is_external: false,
        claimed_at: "2026-04-20T10:00:00Z",
      },
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(makeListing(), "system-user-id");

    expect(result).toBe("skipped");
  });

  it("skips when existing row has claimed_at set even if is_external is still true", async () => {
    setupMockFrom({
      existing: {
        id: "claimed-uuid",
        is_external: true,
        claimed_at: "2026-04-20T10:00:00Z",
      },
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(makeListing(), "system-user-id");

    expect(result).toBe("skipped");
  });

  it("returns skipped when the atomic UPDATE predicate filters the row (TOCTOU race)", async () => {
    // The early SELECT saw is_external=true + claimed_at=null, so the guard
    // lets us through. Between that SELECT and the UPDATE, an admin approval
    // flipped the row. The UPDATE's .eq("is_external", true).is("claimed_at",
    // null) predicate now matches zero rows — simulated by updateFilteredOut.
    setupMockFrom({
      existing: { id: "raced-uuid", is_external: true, claimed_at: null },
      updateFilteredOut: true,
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(makeListing(), "system-user-id");

    expect(result).toBe("skipped");
  });
});

describe("new listing insertion", () => {
  it("inserts when no existing record found", async () => {
    mockUploadImages.mockResolvedValue([
      { url: "https://storage/img.jpg", alt_text: "Cessna 172" },
    ]);
    setupMockFrom({ existing: null });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(makeListing(), "system-user-id");

    expect(result).toBe("inserted");
  });
});

describe("manufacturer resolution", () => {
  it("resolves manufacturer from reference specs list", async () => {
    mockUploadImages.mockResolvedValue([
      { url: "https://storage/img.jpg", alt_text: "" },
    ]);

    let capturedRecord: any = null;
    setupMockFrom({
      refSpecManufacturers: ["Cessna", "Piper", "Diamond"],
      manufacturers: [
        { id: 1, name: "Cessna" },
        { id: 2, name: "Piper" },
      ],
      existing: null,
      captureInsert: (rec) => { capturedRecord = rec; },
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(
      makeListing({ title: "Piper PA-28 Cherokee" }),
      "system-user-id",
    );

    expect(result).toBe("inserted");
    expect(capturedRecord).not.toBeNull();
    expect(capturedRecord.manufacturer_id).toBe(2);
  });

  it("sets null manufacturer_id for unknown aircraft", async () => {
    mockUploadImages.mockResolvedValue([
      { url: "https://storage/img.jpg", alt_text: "" },
    ]);

    let capturedRecord: any = null;
    setupMockFrom({
      refSpecManufacturers: [],
      manufacturers: [],
      existing: null,
      captureInsert: (rec) => { capturedRecord = rec; },
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(
      makeListing({ title: "XYZ Unknown Aircraft" }),
      "system-user-id",
    );

    expect(result).toBe("inserted");
    expect(capturedRecord).not.toBeNull();
    expect(capturedRecord.manufacturer_id).toBeNull();
  });
});

describe("skip conditions", () => {
  it("skips listing with no images", async () => {
    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(
      makeListing({ imageUrls: [] }),
      "system-user-id",
    );

    expect(result).toBe("skipped");
  });
});

describe("error handling", () => {
  it("returns skipped on DB insert constraint error", async () => {
    mockUploadImages.mockResolvedValue([
      { url: "https://storage/img.jpg", alt_text: "" },
    ]);
    setupMockFrom({
      existing: null,
      insertResult: {
        data: null,
        error: { message: 'violates check constraint "description_check"' },
      },
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(
      makeListing({ title: "Bad Listing", description: "x" }),
      "system-user-id",
    );

    expect(result).toBe("skipped");
  });
});

describe("title cleaning", () => {
  it("strips date prefix from title before processing", async () => {
    mockUploadImages.mockResolvedValue([
      { url: "https://storage/img.jpg", alt_text: "" },
    ]);

    let capturedRecord: any = null;
    setupMockFrom({
      existing: null,
      captureInsert: (rec) => { capturedRecord = rec; },
    });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    await upsertAircraftListing(
      makeListing({ title: "17.01.2025 Cessna 172" }),
      "system-user-id",
    );

    expect(capturedRecord).not.toBeNull();
    expect(capturedRecord.headline).toBe("Cessna 172");
  });
});
