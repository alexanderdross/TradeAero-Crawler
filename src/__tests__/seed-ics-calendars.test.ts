import { describe, expect, it } from "vitest";
import { extractIcsFeeds } from "../scripts/seed-ics-calendars.js";

// ─────────────────────────────────────────────────────────────────────────────
// Coverage for the HTML → ICS-feed extractor used by the
// `seed-ics-calendars` discovery script. Internet access isn't
// available in CI, so we exercise the parser directly against
// hand-crafted fixtures that mirror the real-world patterns the
// script needs to recognise.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = "https://example.org/events/";

describe("extractIcsFeeds", () => {
  it("returns nothing when the page has no calendar hints", () => {
    const html = `<!doctype html><html><body><p>No feed here.</p></body></html>`;
    expect(extractIcsFeeds(html, PAGE)).toEqual([]);
  });

  it("picks up an absolute .ics anchor link", () => {
    const html = `<a href="https://example.org/cal/all.ics">Subscribe</a>`;
    const out = extractIcsFeeds(html, PAGE);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      feedUrl: "https://example.org/cal/all.ics",
      via: "anchor-href",
    });
  });

  it("resolves a relative .ics anchor against the page URL", () => {
    const html = `<a href="../feed/events.ics">Cal</a>`;
    const out = extractIcsFeeds(html, PAGE);
    expect(out).toHaveLength(1);
    expect(out[0].feedUrl).toBe("https://example.org/feed/events.ics");
  });

  it("recognises webcal:// scheme and absolutises against page", () => {
    const html = `<a href="webcal://example.org/cal/all.ics">Add to Calendar</a>`;
    const out = extractIcsFeeds(html, PAGE);
    expect(out).toHaveLength(1);
    expect(out[0].via).toBe("webcal");
    expect(out[0].feedUrl.endsWith("example.org/cal/all.ics")).toBe(true);
  });

  it("matches .ics with a query string", () => {
    const html = `<a href="https://x.test/cal.ics?token=abc">cal</a>`;
    const out = extractIcsFeeds(html, PAGE);
    expect(out).toHaveLength(1);
    expect(out[0].feedUrl).toBe("https://x.test/cal.ics?token=abc");
  });

  it("matches .ical extension as well as .ics", () => {
    const html = `<a href="https://x.test/cal.ical">cal</a>`;
    expect(extractIcsFeeds(html, PAGE)).toEqual([
      { feedUrl: "https://x.test/cal.ical", via: "anchor-href" },
    ]);
  });

  it("picks up <link rel='alternate' type='text/calendar'>", () => {
    const html = `
      <html>
        <head>
          <link rel="alternate" type="text/calendar" href="/feeds/events.ics" />
        </head>
        <body>no anchor link here</body>
      </html>`;
    const out = extractIcsFeeds(html, PAGE);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      feedUrl: "https://example.org/feeds/events.ics",
      via: "link-alternate",
    });
  });

  it("deduplicates the same absolute URL surfaced via two different links", () => {
    const html = `
      <link rel="alternate" type="text/calendar" href="https://x.test/cal.ics" />
      <a href="https://x.test/cal.ics">subscribe</a>`;
    const out = extractIcsFeeds(html, PAGE);
    expect(out).toHaveLength(1);
    // Anchor scan runs first in extractIcsFeeds, so the anchor entry
    // wins on dedup; the <link> alternate is skipped because the URL
    // is already in the result Map.
    expect(out[0].via).toBe("anchor-href");
  });

  it("ignores hrefs that merely contain 'ics' as a substring without the extension", () => {
    const html = `
      <a href="/topics-and-things">topics</a>
      <a href="https://x.test/no-cal-here">no cal</a>`;
    expect(extractIcsFeeds(html, PAGE)).toEqual([]);
  });

  it("returns multiple distinct feeds when a page exposes per-category calendars", () => {
    const html = `
      <a href="https://x.test/cal/seminars.ics">seminars</a>
      <a href="https://x.test/cal/competitions.ics">competitions</a>
      <a href="https://x.test/cal/festivals.ics">festivals</a>`;
    const out = extractIcsFeeds(html, PAGE);
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.feedUrl)).toEqual([
      "https://x.test/cal/seminars.ics",
      "https://x.test/cal/competitions.ics",
      "https://x.test/cal/festivals.ics",
    ]);
  });

  it("ignores empty hrefs", () => {
    const html = `<a href="">empty</a><a>nothing</a>`;
    expect(extractIcsFeeds(html, PAGE)).toEqual([]);
  });

  it("survives malformed hrefs without throwing", () => {
    const html = `<a href="ht!tp://broken url . ics">broken</a>`;
    // Either 0 results (URL constructor throws and we skip) or one
    // result (browsers and the URL constructor are surprisingly
    // forgiving). The hard contract is "doesn't throw".
    expect(() => extractIcsFeeds(html, PAGE)).not.toThrow();
  });
});
