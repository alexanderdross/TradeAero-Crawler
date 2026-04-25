import { config } from "../config.js";
import { parsePilotenausbildungPage } from "../parsers/pilotenausbildung.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl pilotenausbildung.net /ausflugstipps/. Single-page source —
 * everything lives at one URL with multiple <h2> sections; the parser
 * walks them and skips reference-only sections (museums, airport
 * activities). No proxy required (Apache, no Cloudflare).
 */
export async function crawlPilotenausbildung(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`pilotenausbildung has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.pilotenausbildung;
  return [
    await runEventCrawler({
      sourceName: src.name,
      pages: (src.events ?? []).map((url) => ({ url })),
      useProxy: src.useProxy,
      parsePage: (html, page, sourceName) =>
        parsePilotenausbildungPage(html, page.url, sourceName),
    }),
  ];
}
