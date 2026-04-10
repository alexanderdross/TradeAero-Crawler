import { describe, it, expect } from "vitest";
import { generateSlug, generateLocalizedSlugs } from "../utils/slug.js";

describe("generateSlug", () => {
  it("converts basic text to a slug", () => {
    expect(generateSlug("Cessna 172 Skyhawk")).toBe("cessna-172-skyhawk");
  });

  it("handles German umlauts", () => {
    expect(generateSlug("Flügel für Überlandflug")).toBe("flugel-fur-uberlandflug");
  });

  it("removes special characters", () => {
    expect(generateSlug("Price: €12,500! (negotiable)")).toBe("price-12-500-negotiable");
  });

  it("collapses consecutive hyphens", () => {
    expect(generateSlug("hello --- world")).toBe("hello-world");
  });

  it("strips leading and trailing hyphens", () => {
    expect(generateSlug("  --hello world--  ")).toBe("hello-world");
  });

  it("truncates to max 80 characters", () => {
    const longText = "a".repeat(100);
    const slug = generateSlug(longText);
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it("truncates long text with words to max 80 characters", () => {
    const longText = "Ultraleichtflugzeug mit Rotax Motor und komplettem Rettungssystem zu verkaufen in der Naehe von Muenchen Bayern Deutschland";
    const slug = generateSlug(longText);
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it("appends listing number when provided", () => {
    expect(generateSlug("Cessna 172", 42)).toBe("cessna-172-42");
  });

  it("does not append listing number when it is 0 (falsy)", () => {
    expect(generateSlug("Cessna 172", 0)).toBe("cessna-172");
  });

  it("handles empty string", () => {
    expect(generateSlug("")).toBe("");
  });

  it("handles numbers only", () => {
    expect(generateSlug("12345")).toBe("12345");
  });

  it("handles string with only special characters", () => {
    expect(generateSlug("@#$%^&*")).toBe("");
  });

  it("never introduces double hyphens around the listing number suffix", () => {
    // Regression: the crawler used to produce URLs like
    //   .../brm-aero-bristell-rg-bristell-ul-mit-einziehfahrwerk-dynonavionics-skyviewtouch--2503/
    // when the body ended in a hyphen after the slice(0, 80) truncation,
    // and the `-${listingNumber}` suffix was concatenated on top of it.
    expect(generateSlug("Cessna 172S -", 101)).toBe("cessna-172s-101");
    expect(generateSlug("Cessna 172S - - -", 101)).toBe("cessna-172s-101");
    expect(
      generateSlug(
        "BRM Aero Bristell RG - Bristell UL mit Einziehfahrwerk Dynonavionics SkyViewTouch",
        2503,
      ),
    ).not.toMatch(/--/);
    // Explicit check: a title long enough to trigger the slice(0, 80) path
    // must still produce a single-hyphen suffix.
    const longTitle =
      "Ultraleichtflugzeug Bristell UL mit Einziehfahrwerk Dynonavionics SkyViewTouch";
    expect(generateSlug(longTitle, 2503)).not.toMatch(/--/);
  });

  describe("Cyrillic transliteration (Russian)", () => {
    it("transliterates Russian text", () => {
      expect(generateSlug("Москва")).toBe("moskva");
    });

    it("transliterates complex Russian text", () => {
      expect(generateSlug("Самолёт продаётся")).toBe("samolyot-prodayotsya");
    });

    it("handles ж, ш, щ, ч correctly", () => {
      expect(generateSlug("жшщч")).toBe("zhshshchch");
    });

    it("strips ъ and ь (hard/soft sign)", () => {
      expect(generateSlug("объект")).toBe("obekt");
    });
  });

  describe("Greek transliteration", () => {
    it("transliterates basic Greek text without diacritics", () => {
      expect(generateSlug("αθηνα")).toBe("athina");
    });

    it("transliterates Greek with accented vowels (accent stripped via NFD)", () => {
      // ή is not in GREEK_MAP (only η is), so transliterate passes it through.
      // NFD then decomposes it, accent mark is stripped, leaving non-mapped η → replaced by hyphen.
      expect(generateSlug("αθήνα")).toBe("ath-na");
    });

    it("handles θ, ψ, ξ correctly", () => {
      expect(generateSlug("θψξ")).toBe("thpsx");
    });

    it("handles final sigma ς", () => {
      expect(generateSlug("λογος")).toBe("logos");
    });

    it("handles final sigma ς in word", () => {
      // ό has accent, not in map, passes through → NFD strips accent → leftover non-ASCII → hyphen
      expect(generateSlug("λόγος")).toBe("l-gos");
    });
  });

  describe("Turkish transliteration", () => {
    it("transliterates Turkish-specific characters", () => {
      expect(generateSlug("İstanbul güneş")).toBe("istanbul-gunes");
    });

    it("handles ğ, ş, ç, ö, ü, ı", () => {
      expect(generateSlug("ığşçöü")).toBe("igscou");
    });
  });
});

describe("generateLocalizedSlugs", () => {
  it("generates slugs for multiple locales", () => {
    const translations = {
      en: { headline: "Cessna 172 for sale" },
      de: { headline: "Cessna 172 zu verkaufen" },
      fr: { headline: "Cessna 172 à vendre" },
    };
    const slugs = generateLocalizedSlugs(translations);
    expect(slugs).toEqual({
      en: "cessna-172-for-sale",
      de: "cessna-172-zu-verkaufen",
      fr: "cessna-172-a-vendre",
    });
  });

  it("generates slugs with listing number", () => {
    const translations = {
      en: { headline: "Piper PA-28" },
      de: { headline: "Piper PA-28" },
    };
    const slugs = generateLocalizedSlugs(translations, 99);
    expect(slugs).toEqual({
      en: "piper-pa-28-99",
      de: "piper-pa-28-99",
    });
  });

  it("handles Russian locale", () => {
    const translations = {
      ru: { headline: "Самолёт Cessna 172" },
    };
    const slugs = generateLocalizedSlugs(translations);
    expect(slugs.ru).toBe("samolyot-cessna-172");
  });

  it("handles empty translations object", () => {
    const slugs = generateLocalizedSlugs({});
    expect(slugs).toEqual({});
  });
});
