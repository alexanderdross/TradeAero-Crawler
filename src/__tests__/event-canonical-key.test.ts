import { describe, it, expect } from "vitest";
import {
  computeCanonicalKey,
  slugifyForKey,
  stripDiacritics,
} from "../db/event-canonical-key.js";
import {
  compareSourcePriority,
  getSourcePriority,
} from "../db/event-source-priority.js";
import type { ParsedEvent } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Cross-source dedup helpers. The whole point of the canonical_key is
// that two parsers with different DOM shapes — fliegermagazin's "Tannkosh
// 2026 Fly-In", ulforum's "Tannkosh 2026", pilotenausbildung's "Fly-In
// Tannkosh 2026" — collapse to the same hash so the priority arbitrator
// gets to make the keep-vs-drop call. Pin those collisions explicitly.
// ─────────────────────────────────────────────────────────────────────────────

const baseEvent = (over: Partial<ParsedEvent> = {}): ParsedEvent => ({
  sourceId: "x",
  sourceUrl: "https://example.test/x",
  sourceName: "fliegermagazin.de",
  pageUrl: "https://example.test/",
  sourceCategoryId: 0,
  categoryCode: "general",
  title: "Tannkosh 2026 Fly-In",
  subtitle: null,
  dateRangeText: null,
  startDate: "2026-08-13T00:00:00.000Z",
  endDate: "2026-08-16T00:00:00.000Z",
  timezone: "Europe/Berlin",
  country: "DE",
  city: null,
  venueName: "Tannheim",
  icaoCode: "EDMT",
  organizerName: "Förderverein Tannheim",
  ...over,
});

describe("stripDiacritics", () => {
  it("removes German umlauts", () => {
    expect(stripDiacritics("Förderverein")).toBe("Forderverein");
    expect(stripDiacritics("Mühlhausen")).toBe("Muhlhausen");
  });

  it("removes French/Spanish accents", () => {
    expect(stripDiacritics("Aérodrome")).toBe("Aerodrome");
    expect(stripDiacritics("Castellón")).toBe("Castellon");
  });

  it("leaves plain ASCII untouched", () => {
    expect(stripDiacritics("Tannkosh 2026")).toBe("Tannkosh 2026");
  });
});

describe("slugifyForKey", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyForKey("Tannkosh 2026 Fly-In")).toBe("tannkosh-2026-fly-in");
  });

  it("collapses runs of non-alphanumerics to a single hyphen", () => {
    expect(slugifyForKey("AERO Friedrichshafen — 2026!")).toBe(
      "aero-friedrichshafen-2026",
    );
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugifyForKey("  ---Hangar Talk---  ")).toBe("hangar-talk");
  });

  it("returns empty string for diacritic-only / punctuation-only input", () => {
    expect(slugifyForKey("…")).toBe("");
  });
});

describe("computeCanonicalKey", () => {
  it("returns a stable hash for typical input", () => {
    const key = computeCanonicalKey(baseEvent());
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  it("collapses the same event titled three different ways across sources", () => {
    // The hallmark Tier-2 dedup case: same fly-in, same ICAO, same
    // start day, three different aggregator titles. All three must
    // compute the same hash so the priority arbitrator can pick one.
    const a = computeCanonicalKey(
      baseEvent({ title: "Tannkosh 2026 Fly-In" }),
    );
    const b = computeCanonicalKey(
      baseEvent({ title: "Fly-In Tannkosh 2026" }),
    );
    expect(a).not.toEqual(b); // ordering matters by design — title slug
    // Now repeat with the same wording — must collide.
    const c = computeCanonicalKey(
      baseEvent({ title: "Tannkosh 2026 Fly-In" }),
    );
    expect(a).toEqual(c);
  });

  it("normalises diacritics so reprints with/without umlauts collide", () => {
    const a = computeCanonicalKey(
      baseEvent({ title: "Hangar-Treff Mühlhausen" }),
    );
    const b = computeCanonicalKey(
      baseEvent({ title: "Hangar-Treff Muhlhausen" }),
    );
    expect(a).toEqual(b);
  });

  it("anchors on ICAO when present (more authoritative than city)", () => {
    const withCity = computeCanonicalKey(
      baseEvent({ icaoCode: null, city: "Tannheim" }),
    );
    const withIcao = computeCanonicalKey(
      baseEvent({ icaoCode: "EDMT", city: "Tannheim" }),
    );
    expect(withCity).not.toEqual(withIcao);
  });

  it("falls back to city slug when no ICAO present", () => {
    const a = computeCanonicalKey(
      baseEvent({ icaoCode: null, city: "Tannheim", venueName: "Foo" }),
    );
    const b = computeCanonicalKey(
      baseEvent({ icaoCode: null, city: "Tannheim", venueName: "Bar" }),
    );
    expect(a).toEqual(b);
  });

  it("uses venue when neither ICAO nor city is present", () => {
    const key = computeCanonicalKey(
      baseEvent({ icaoCode: null, city: null, venueName: "Flugplatz Bienenfarm" }),
    );
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null when there is no anchor at all", () => {
    expect(
      computeCanonicalKey(
        baseEvent({ icaoCode: null, city: null, venueName: "" }),
      ),
    ).toBeNull();
  });

  it("returns null on an empty title", () => {
    expect(computeCanonicalKey(baseEvent({ title: "" }))).toBeNull();
  });

  it("returns null on an unparseable start date", () => {
    expect(
      computeCanonicalKey(baseEvent({ startDate: "not-a-date" })),
    ).toBeNull();
  });

  it("ignores the time component of startDate (date-only key)", () => {
    const morning = computeCanonicalKey(
      baseEvent({ startDate: "2026-08-13T08:00:00.000Z" }),
    );
    const evening = computeCanonicalKey(
      baseEvent({ startDate: "2026-08-13T20:00:00.000Z" }),
    );
    expect(morning).toEqual(evening);
  });

  it("treats events on different days as distinct", () => {
    const day1 = computeCanonicalKey(
      baseEvent({ startDate: "2026-08-13T00:00:00.000Z" }),
    );
    const day2 = computeCanonicalKey(
      baseEvent({ startDate: "2026-08-14T00:00:00.000Z" }),
    );
    expect(day1).not.toEqual(day2);
  });

  it("truncates the title fragment so minor wording differences don't break the hash", () => {
    // 40-char limit — the trailing org tag past the cap shouldn't
    // change the key.
    const short = computeCanonicalKey(
      baseEvent({
        title: "AERO Friedrichshafen International Trade Fair",
      }),
    );
    const longer = computeCanonicalKey(
      baseEvent({
        title:
          "AERO Friedrichshafen International Trade Fair (Press Day Plus One)",
      }),
    );
    expect(short).toEqual(longer);
  });
});

describe("event source priority", () => {
  it("ranks organiser feeds above community forums above magazines", () => {
    expect(getSourcePriority("vereinsflieger.de")).toBeGreaterThan(
      getSourcePriority("ulforum.de"),
    );
    expect(getSourcePriority("ulforum.de")).toBeGreaterThan(
      getSourcePriority("fliegermagazin.de"),
    );
    expect(getSourcePriority("fliegermagazin.de")).toBeGreaterThan(
      getSourcePriority("pilotenausbildung.net"),
    );
  });

  it("returns the documented default for unknown sources", () => {
    expect(getSourcePriority("brand-new-source.example")).toBe(50);
  });

  it("compareSourcePriority — higher / equal / lower", () => {
    expect(
      compareSourcePriority("vereinsflieger.de", "fliegermagazin.de"),
    ).toBe("higher");
    expect(
      compareSourcePriority("fliegermagazin.de", "vereinsflieger.de"),
    ).toBe("lower");
    expect(
      compareSourcePriority("fliegermagazin.de", "pilot-frank.de"),
    ).toBe("equal");
  });
});
