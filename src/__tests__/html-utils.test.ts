import { describe, expect, it } from "vitest";
import {
  cleanText,
  decodeEmail,
  extractNumber,
  generateSourceId,
  parseGermanDate,
  parsePrice,
} from "../utils/html.js";

describe("decodeEmail", () => {
  it("decodes [at] pattern", () => {
    expect(decodeEmail("user[at]example.de")).toBe("user@example.de");
  });

  it("decodes (at) pattern", () => {
    expect(decodeEmail("user (at) example.de")).toBe("user@example.de");
  });

  it("decodes hex-encoded characters", () => {
    expect(decodeEmail("%66ly2dr%69me@g%6dail%2ecom")).toBe("fly2drime@gmail.com");
  });

  it("handles combined obfuscation", () => {
    expect(decodeEmail("%66ly2dr%69me[at]g%6dail%2ecom")).toBe("fly2drime@gmail.com");
  });
});

describe("parsePrice", () => {
  it("parses simple Euro price", () => {
    expect(parsePrice("€12500")).toEqual({ amount: 12500, negotiable: false });
  });

  it("parses German-formatted price with dot separator", () => {
    expect(parsePrice("€12.500,-")).toEqual({ amount: 12500, negotiable: false });
  });

  it("parses price with VB suffix", () => {
    expect(parsePrice("€8.900 VB")).toEqual({ amount: 8900, negotiable: true });
  });

  it("parses fixed price with FP", () => {
    expect(parsePrice("€15.000 FP")).toEqual({ amount: 15000, negotiable: false });
  });

  it("returns null for empty string", () => {
    expect(parsePrice("")).toEqual({ amount: null, negotiable: false });
  });
});

describe("parseGermanDate", () => {
  it("parses DD.MM.YYYY format", () => {
    expect(parseGermanDate("15.03.2024")).toBe("2024-03-15");
  });

  it("returns null for invalid format", () => {
    expect(parseGermanDate("invalid")).toBeNull();
  });
});

describe("extractNumber", () => {
  it("extracts simple integer", () => {
    expect(extractNumber("450")).toBe(450);
  });

  it("extracts German-formatted number", () => {
    expect(extractNumber("1.234,5")).toBe(1234.5);
  });

  it("returns null for non-numeric text", () => {
    expect(extractNumber("keine Angabe")).toBeNull();
  });
});

describe("cleanText", () => {
  it("collapses whitespace", () => {
    expect(cleanText("hello   world")).toBe("hello world");
  });

  it("decodes HTML entities", () => {
    expect(cleanText("Müller &amp; Söhne")).toBe("Müller & Söhne");
  });
});

describe("generateSourceId", () => {
  it("generates id with date", () => {
    expect(generateSourceId("https://example.de/page.html", 5, "2024-03-15")).toBe(
      "https://example.de/page.html#5@2024-03-15"
    );
  });

  it("generates id without date", () => {
    expect(generateSourceId("https://example.de/page.html", 3)).toBe(
      "https://example.de/page.html#3"
    );
  });
});
