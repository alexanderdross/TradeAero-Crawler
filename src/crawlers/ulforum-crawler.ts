import { config } from "../config.js";
import { parseUlforumPage } from "../parsers/ulforum.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl ulforum.de /veranstaltungen. Single-page source — the
 * community forum lists all upcoming Fly-Ins / pilot meetups on one
 * URL with embedded JSON-LD. No proxy required (Apache, no Cloudflare).
 */
export async function crawlUlforum(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`ulforum has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.ulforum;
  return [
    await runEventCrawler({
      sourceName: src.name,
      pages: (src.events ?? []).map((url) => ({ url })),
      useProxy: src.useProxy,
      parsePage: (html, page, sourceName) =>
        parseUlforumPage(html, page.url, sourceName),
    }),
  ];
}
