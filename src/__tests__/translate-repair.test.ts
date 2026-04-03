import { describe, expect, it } from "vitest";

/**
 * Tests for the JSON repair logic used in translate.ts
 * to handle truncated Claude responses.
 */

// Replicate the repair logic from translate.ts for isolated testing
function repairJson(raw: string): any {
  // Strip markdown code fences
  let jsonStr = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  // Fix trailing commas before closing braces/brackets
  jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");

  // First attempt: parse as-is
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Attempt repair
    let repaired = jsonStr;

    // Count unbalanced quotes — if odd, add closing quote
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) repaired += '"';

    // Close unclosed braces
    const opens = (repaired.match(/\{/g) || []).length;
    const closes = (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) repaired += "}";

    // Close unclosed brackets
    const openBr = (repaired.match(/\[/g) || []).length;
    const closeBr = (repaired.match(/\]/g) || []).length;
    for (let i = 0; i < openBr - closeBr; i++) repaired += "]";

    // Remove trailing commas again after repair
    repaired = repaired.replace(/,\s*([\]}])/g, "$1");

    return JSON.parse(repaired);
  }
}

describe("repairJson — trailing comma fix", () => {
  it("fixes trailing comma before closing brace", () => {
    const input = '{"en": {"headline": "test", "description": "desc",}}';
    const result = repairJson(input);
    expect(result.en.headline).toBe("test");
  });

  it("fixes trailing comma before closing bracket", () => {
    const input = '["a", "b", "c",]';
    const result = repairJson(input);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("fixes multiple trailing commas", () => {
    const input = '{"a": {"b": "c",}, "d": "e",}';
    const result = repairJson(input);
    expect(result.a.b).toBe("c");
    expect(result.d).toBe("e");
  });
});

describe("repairJson — unclosed structures", () => {
  it("closes single unclosed brace", () => {
    const input = '{"en": {"headline": "test", "description": "desc"}';
    const result = repairJson(input);
    expect(result.en.headline).toBe("test");
  });

  it("closes multiple unclosed braces", () => {
    const input = '{"en": {"headline": "test"';
    const result = repairJson(input);
    expect(result.en.headline).toBe("test");
  });

  it("closes unclosed string quote", () => {
    const input = '{"en": {"headline": "test", "description": "some desc';
    const result = repairJson(input);
    expect(result.en.headline).toBe("test");
  });

  it("closes unclosed bracket", () => {
    const input = '["a", "b"';
    const result = repairJson(input);
    expect(result).toEqual(["a", "b"]);
  });
});

describe("repairJson — markdown stripping", () => {
  it("strips ```json code fences", () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = repairJson(input);
    expect(result.key).toBe("value");
  });

  it("strips ``` without json label", () => {
    const input = '```\n{"key": "value"}\n```';
    const result = repairJson(input);
    expect(result.key).toBe("value");
  });
});

describe("repairJson — valid JSON passthrough", () => {
  it("parses valid JSON without modification", () => {
    const input = '{"en": {"headline": "Cessna 172S", "description": "Well maintained"}}';
    const result = repairJson(input);
    expect(result.en.headline).toBe("Cessna 172S");
    expect(result.en.description).toBe("Well maintained");
  });

  it("handles empty object", () => {
    const result = repairJson("{}");
    expect(result).toEqual({});
  });

  it("handles nested valid JSON", () => {
    const input = JSON.stringify({
      en: { headline: "test", description: "desc" },
      de: { headline: "Test", description: "Beschr" },
    });
    const result = repairJson(input);
    expect(result.en.headline).toBe("test");
    expect(result.de.headline).toBe("Test");
  });
});

describe("repairJson — combined issues", () => {
  it("handles trailing comma + unclosed brace", () => {
    const input = '{"en": {"headline": "test",}';
    const result = repairJson(input);
    expect(result.en.headline).toBe("test");
  });

  it("handles markdown + trailing comma + unclosed brace", () => {
    const input = '```json\n{"en": {"headline": "Cessna",}';
    const result = repairJson(input);
    expect(result.en.headline).toBe("Cessna");
  });
});
