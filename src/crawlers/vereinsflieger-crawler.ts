import { config } from "../config.js";
import { parseVereinsfliegerPage } from "../parsers/vereinsflieger.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl vereinsflieger.de/publiccalendar. The only supported target is
 * `events` — aircraft/parts URLs are left empty in SourceConfig so
 * `crawlVereinsflieger("all")` is equivalent to `crawlVereinsflieger("events")`.
 *
 * Orchestrator boilerplate (start run / fetch / upsert / complete run)
 * lives in `runEventCrawler` so adding a new bespoke source means
 * writing only the parser.
 */
export async function crawlVereinsflieger(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`Vereinsflieger has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.vereinsflieger;
  return [
    await runEventCrawler({
      sourceName: src.name,
      pages: (src.events ?? []).map((url) => ({ url })),
      useProxy: src.useProxy,
      parsePage: (html, page, sourceName) =>
        parseVereinsfliegerPage(html, page.url, sourceName),
    }),
  ];
}
