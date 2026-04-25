import { describe, it, expect } from "vitest";
import { buildValidationDropSummary } from "../crawlers/run-summary.js";

// ─────────────────────────────────────────────────────────────────────────────
// `buildValidationDropSummary` is the pure helper that turns the
// runEventCrawler's per-reason skip counter into a one-line warning
// for `crawler_runs.warnings[]`. Pin the format so the admin
// dashboard's regex / split parser doesn't break silently when this
// shape evolves.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildValidationDropSummary", () => {
  it("returns null on an empty reason map", () => {
    expect(buildValidationDropSummary({})).toBeNull();
  });

  it("returns null when only normal skip reasons are present", () => {
    expect(
      buildValidationDropSummary({ unchanged: 12, concurrent_insert: 1 }),
    ).toBeNull();
  });

  it("flags validation drops with total + per-reason breakdown", () => {
    expect(
      buildValidationDropSummary({
        missing_title: 5,
        end_before_start: 7,
      }),
    ).toBe("validation drops: 12 (end_before_start: 7, missing_title: 5)");
  });

  it("orders reasons by count descending", () => {
    expect(
      buildValidationDropSummary({
        missing_title: 1,
        invalid_icao: 3,
        ended_too_long_ago: 2,
      }),
    ).toBe(
      "validation drops: 6 (invalid_icao: 3, ended_too_long_ago: 2, missing_title: 1)",
    );
  });

  it("excludes normal skip reasons from the count + detail", () => {
    expect(
      buildValidationDropSummary({
        unchanged: 100,
        concurrent_insert: 5,
        missing_title: 2,
      }),
    ).toBe("validation drops: 2 (missing_title: 2)");
  });

  it("handles a single validation drop", () => {
    expect(buildValidationDropSummary({ invalid_icao: 1 })).toBe(
      "validation drops: 1 (invalid_icao: 1)",
    );
  });
});
