import { config } from "../config.js";
import {
  parseIataPage,
  parseIataTotalPages,
} from "../parsers/iata.js";
import { fetchPage } from "../utils/fetch.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl iata.org /en/events/. Paginated source — page 1 is the
 * canonical entry; total page count is read off the pagination
 * block on the first response, then pages 2..N are appended.
 *
 * Cloudflare CDN sits in front but `cf-cache-status: HIT` indicates
 * IATA actively serves crawlers from the cache — no proxy needed.
 */
export async function crawlIata(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`iata has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.iata;
  const entryUrls = src.events ?? [];

  const pages: { url: string }[] = [];
  for (const entry of entryUrls) {
    pages.push({ url: entry });
    try {
      const html = await fetchPage(entry, { proxy: src.useProxy });
      const total = parseIataTotalPages(html);
      logger.info("iata pagination discovered", { entry, total });
      const ceiling = Math.min(total, 20);
      for (let i = 2; i <= ceiling; i++) {
        const sep = entry.includes("?") ? "&" : "?";
        pages.push({ url: `${entry}${sep}page=${i}` });
      }
    } catch (err) {
      logger.warn(
        "iata pagination probe failed — proceeding with page 1 only",
        { entry, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  return [
    await runEventCrawler({
      sourceName: src.name,
      pages,
      useProxy: src.useProxy,
      parsePage: (html, page, sourceName) =>
        parseIataPage(html, page.url, sourceName),
    }),
  ];
}
