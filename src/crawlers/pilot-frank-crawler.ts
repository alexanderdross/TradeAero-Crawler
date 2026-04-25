import { config } from "../config.js";
import { parsePilotFrankFeed } from "../parsers/pilot-frank.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl pilot-frank.de /events/feed/. Source is a WordPress + Modern
 * Events Calendar (MEC) RSS feed — `mec:startDate`, `mec:endDate`,
 * `mec:location` give us everything the parser needs without scraping
 * the HTML page. No proxy required (Apache, no Cloudflare).
 */
export async function crawlPilotFrank(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`pilot-frank has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.pilotFrank;
  return [
    await runEventCrawler({
      sourceName: src.name,
      pages: (src.events ?? []).map((url) => ({ url })),
      useProxy: src.useProxy,
      parsePage: (xml, page, sourceName) =>
        parsePilotFrankFeed(xml, page.url, sourceName),
    }),
  ];
}
