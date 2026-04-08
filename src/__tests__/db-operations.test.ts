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

/** Build a mock for aircraft_listings table with configurable dedup + insert/update results */
function listingsMock(opts: {
  existing?: { id: string } | null;
  insertResult?: { data: any; error: any };
  updateError?: any;
}) {
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
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: opts.updateError ?? null }),
    }),
  };
}

function setupMockFrom(opts: {
  refSpecManufacturers?: string[];
  manufacturers?: { id: number; name: string }[];
  existing?: { id: string } | null;
  insertResult?: { data: any; error: any };
  updateError?: any;
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
    setupMockFrom({ existing: { id: "existing-uuid-123" } });

    const { upsertAircraftListing } = await import("../db/aircraft.js");
    const result = await upsertAircraftListing(makeListing(), "system-user-id");

    expect(result).toBe("updated");
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
