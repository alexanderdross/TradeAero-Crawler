import { config } from "../config.js";
import { parseNbaaPage } from "../parsers/nbaa.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl nbaa.org /events/. Single-page source with no pagination — the
 * curated /events/ list shows all upcoming NBAA events in one DOM tree.
 *
 * NBAA sits behind Cloudflare; cloud IPs from GitHub Actions runners
 * occasionally trip a 503. `useProxy: true` routes through Bright Data
 * residential so the request looks like ordinary US traffic.
 */
export async function crawlNbaa(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`nbaa has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.nbaa;
  return [
    await runEventCrawler({
      sourceName: src.name,
      pages: (src.events ?? []).map((url) => ({ url })),
      useProxy: src.useProxy,
      parsePage: (html, page, sourceName) =>
        parseNbaaPage(html, page.url, sourceName),
    }),
  ];
}
