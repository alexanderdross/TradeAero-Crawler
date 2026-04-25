import { describe, it, expect } from "vitest";
import { contentHash, slugify } from "../db/event-dedup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Regression coverage for the crawler-side upsert dedup contract.
// `upsertEvent` itself touches Supabase, the translator, and the
// geocoder — those flows are integration tests against a staging
// project. The HASH + SLUG helpers, however, are pure functions that
// determine which rows count as "the same event" and which slugs
// collide; they need to stay deterministic across runs or the dedup
// guarantee silently breaks (every re-crawl would emit fresh rows).
// ─────────────────────────────────────────────────────────────────────────────

describe("contentHash — re-translate decision key", () => {
  it("is deterministic for the same (title, description)", () => {
    const a = contentHash("Open Day 2026", "Annual fly-in.");
    const b = contentHash("Open Day 2026", "Annual fly-in.");
    expect(a).toBe(b);
  });

  it("changes when the title changes", () => {
    const a = contentHash("Open Day 2026", "Body");
    const b = contentHash("Open Day 2027", "Body");
    expect(a).not.toBe(b);
  });

  it("changes when the description changes", () => {
    const a = contentHash("Title", "First description");
    const b = contentHash("Title", "Second description");
    expect(a).not.toBe(b);
  });

  it("returns a 40-character sha1 hex digest", () => {
    const h = contentHash("x", "y");
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is insensitive to title↔description word shifts (documented behaviour)", () => {
    // The implementation joins `${title} ${description}`, so moving a
    // word across the boundary keeps the same hash. This is
    // intentional: only the combined translatable text matters for
    // the re-translate decision. Pinned here so a future refactor
    // that hashes title/description separately would be visible.
    const a = contentHash("Annual Open", "Day 2026");
    const b = contentHash("Annual", "Open Day 2026");
    expect(a).toBe(b);
  });
});

describe("slugify — base-slug stability + length cap", () => {
  it("returns the same slug for the same title every call", () => {
    expect(slugify("Open Day 2026")).toBe(slugify("Open Day 2026"));
  });

  it("normalises German umlauts and other diacritics", () => {
    const s = slugify("Wettbewerbsfliegen für die Saison");
    expect(s.toLowerCase()).toBe(s);
    expect(s).not.toContain("ü");
    expect(s).not.toContain("ä");
  });

  it("collapses non-alphanumeric runs into single hyphens", () => {
    const s = slugify("Trade & Air-Show :: 2026!");
    // No double-hyphens, no leading/trailing hyphens (before suffix)
    expect(s).not.toMatch(/--/);
    expect(s).not.toMatch(/^-/);
  });

  it("truncates the prefix to 60 chars (before the sha1 suffix)", () => {
    const long = "x".repeat(200);
    const s = slugify(long);
    // Format: <prefix>-<8-hex>
    const [prefix, suffix] = s.split(/-(?=[0-9a-f]{8}$)/);
    expect(prefix.length).toBeLessThanOrEqual(60);
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  it("falls back to 'event' prefix when the title is non-alphanumeric only", () => {
    const s = slugify("!!!???");
    expect(s.startsWith("event-")).toBe(true);
  });

  it("emits a stable 8-char sha1 suffix derived from the full title", () => {
    // Suffix is sha1(title).slice(0,8) — important: two titles that
    // differ only after the 60-char prefix cap MUST get different
    // suffixes, or the slug collides on UNIQUE.
    const a = slugify("x".repeat(60) + "-suffix-A");
    const b = slugify("x".repeat(60) + "-suffix-B");
    expect(a).not.toBe(b);
  });
});
