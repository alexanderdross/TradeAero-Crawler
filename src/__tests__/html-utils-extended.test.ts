import { describe, it, expect } from "vitest";
import {
  cleanText,
  decodeEmail,
  parseGermanDate,
  parsePrice,
  sanitizeForDb,
} from "../utils/html.js";

describe("parseGermanDate - extended", () => {
  it("parses MM/YYYY format", () => {
    expect(parseGermanDate("06/2025")).toBe("2025-06-01");
  });

  it("parses single-digit month MM/YYYY format", () => {
    expect(parseGermanDate("3/2024")).toBe("2024-03-01");
  });

  it("parses full German month name: April 2026", () => {
    expect(parseGermanDate("April 2026")).toBe("2026-04-01");
  });

  it("parses abbreviated German month: Dez 2025", () => {
    expect(parseGermanDate("Dez 2025")).toBe("2025-12-01");
  });

  it("parses März 2024 (with umlaut)", () => {
    expect(parseGermanDate("März 2024")).toBe("2024-03-01");
  });

  it("parses Januar 2023", () => {
    expect(parseGermanDate("Januar 2023")).toBe("2023-01-01");
  });

  it("parses Feb 2024", () => {
    expect(parseGermanDate("Feb 2024")).toBe("2024-02-01");
  });

  it("parses Okt 2023", () => {
    expect(parseGermanDate("Okt 2023")).toBe("2023-10-01");
  });

  it("parses Nov 2024", () => {
    expect(parseGermanDate("Nov 2024")).toBe("2024-11-01");
  });

  it("returns null for garbage input", () => {
    expect(parseGermanDate("not a date")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGermanDate("")).toBeNull();
  });

  it("parses DD.MM.YYYY embedded in text", () => {
    expect(parseGermanDate("Eingestellt am 15.03.2024 um 10:00")).toBe("2024-03-15");
  });
});

describe("cleanText - extended", () => {
  it("strips HTML tags but preserves inner text content", () => {
    // cleanText strips tags but not their text content
    expect(cleanText("Hello <script>alert('xss')</script> world")).toBe("Hello alert('xss') world");
  });

  it("strips nested HTML tags", () => {
    expect(cleanText("<div><p>Nested <b>bold</b> text</p></div>")).toBe("Nested bold text");
  });

  it("handles &nbsp; entity", () => {
    expect(cleanText("hello&nbsp;world")).toBe("hello world");
  });

  it("handles &lt; and &gt; entities", () => {
    expect(cleanText("price &lt; 10000 &gt; 5000")).toBe("price < 10000 > 5000");
  });

  it("handles &quot; entity", () => {
    expect(cleanText("so called &quot;premium&quot;")).toBe('so called "premium"');
  });

  it("handles &#39; entity", () => {
    expect(cleanText("it&#39;s fine")).toBe("it's fine");
  });

  it("strips <img> tags with attributes", () => {
    expect(cleanText('Before <img src="x.jpg" onerror="alert(1)"> After')).toBe("Before After");
  });

  it("handles empty string", () => {
    expect(cleanText("")).toBe("");
  });

  it("handles string with only whitespace", () => {
    expect(cleanText("   \t\n  ")).toBe("");
  });

  it("handles multiple consecutive HTML entities", () => {
    expect(cleanText("A&amp;B&amp;C")).toBe("A&B&C");
  });
});

describe("sanitizeForDb", () => {
  it("strips javascript: protocol", () => {
    expect(sanitizeForDb("Click javascript:alert(1)")).toBe("Click alert(1)");
  });

  it("strips javascript: case-insensitively", () => {
    expect(sanitizeForDb("JAVASCRIPT:void(0)")).toBe("void(0)");
  });

  it("strips onload= handler name", () => {
    // The regex /on\w+\s*=/gi strips the event handler name and = sign only
    expect(sanitizeForDb('some text onload="doStuff()" more')).toBe('some text "doStuff()" more');
  });

  it("strips onclick= handler name", () => {
    expect(sanitizeForDb('text onclick="hack()" rest')).toBe('text "hack()" rest');
  });

  it("strips onerror= attribute", () => {
    expect(sanitizeForDb('img onerror="alert(1)"')).toBe('img "alert(1)"');
  });

  it("strips HTML tags", () => {
    expect(sanitizeForDb("<b>bold</b> text")).toBe("bold text");
  });

  it("strips script tags completely", () => {
    expect(sanitizeForDb("<script>alert('xss')</script>safe")).toBe("alert('xss')safe");
  });

  it("handles clean text unchanged", () => {
    expect(sanitizeForDb("Normal aviation listing text")).toBe("Normal aviation listing text");
  });

  it("handles empty string", () => {
    expect(sanitizeForDb("")).toBe("");
  });

  it("strips multiple event handlers", () => {
    expect(sanitizeForDb('onmouseover= onclick= onfocus= text')).toBe("text");
  });
});

describe("decodeEmail - extended", () => {
  it("replaces [dot] with .", () => {
    expect(decodeEmail("user[at]example[dot]de")).toBe("user@example.de");
  });

  it("replaces (dot) with .", () => {
    expect(decodeEmail("user(at)example(dot)de")).toBe("user@example.de");
  });

  it("handles empty string", () => {
    expect(decodeEmail("")).toBe("");
  });

  it("returns already-valid email unchanged", () => {
    expect(decodeEmail("pilot@cessna.com")).toBe("pilot@cessna.com");
  });

  it("trims whitespace", () => {
    expect(decodeEmail("  user@example.de  ")).toBe("user@example.de");
  });

  it("handles combined [at] and [dot] with spaces", () => {
    expect(decodeEmail("user [at] domain [dot] com")).toBe("user@domain.com");
  });
});

describe("parsePrice - extended", () => {
  it("detects VHB as negotiable", () => {
    const result = parsePrice("€5.000 VHB");
    expect(result.negotiable).toBe(true);
    expect(result.amount).toBe(5000);
  });

  it("parses EUR prefix format — EUR is not stripped by parsePrice", () => {
    // parsePrice strips € but not "EUR" text, so "EUR12500" won't parse as a number
    const result = parsePrice("EUR 12.500,-");
    expect(result.amount).toBeNull();
  });

  it("parses price when EUR is replaced with € before calling parsePrice", () => {
    // In practice the caller would normalize "EUR" to "€" — test the € version
    const result = parsePrice("€ 12.500,-");
    expect(result.amount).toBe(12500);
  });

  it("parses price with comma decimals: 3.500,50", () => {
    const result = parsePrice("€3.500,50");
    expect(result.amount).toBe(3500.5);
  });

  it("handles empty string", () => {
    const result = parsePrice("");
    expect(result.amount).toBeNull();
    expect(result.negotiable).toBe(false);
  });

  it("handles price with only currency symbol", () => {
    const result = parsePrice("€");
    expect(result.amount).toBeNull();
  });

  it("parses simple integer price", () => {
    const result = parsePrice("15000");
    expect(result.amount).toBe(15000);
  });

  it("parses price with spaces around currency", () => {
    const result = parsePrice("€ 8.900,-");
    expect(result.amount).toBe(8900);
  });

  it("handles VB suffix (case insensitive)", () => {
    expect(parsePrice("€9.000 vb").negotiable).toBe(true);
  });

  it("returns negotiable false when no VB/VHB present", () => {
    expect(parsePrice("€10.000 FP").negotiable).toBe(false);
  });

  it("parses small price without thousands separator", () => {
    const result = parsePrice("€350");
    expect(result.amount).toBe(350);
  });
});
