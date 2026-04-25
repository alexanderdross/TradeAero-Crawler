import { config } from "../config.js";
import { parseAeroFriedrichshafenPage } from "../parsers/aero-friedrichshafen.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl aero-expo.com — single-page source emitting one ParsedEvent
 * per year for the AERO Friedrichshafen trade fair. The config lists
 * both the English (`aero-expo.com`) and German (`aero-expo.de`) sites
 * so the row gets translated copy on both sides; the cross-source
 * dedup key collapses them into one canonical row.
 *
 * No proxy required — direct fetch with default Chrome UA.
 */
export async function crawlAeroFriedrichshafen(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`aero-friedrichshafen has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.aeroFriedrichshafen;
  return [
    await runEventCrawler({
      sourceName: src.name,
      pages: (src.events ?? []).map((url) => ({ url })),
      useProxy: src.useProxy,
      parsePage: (html, page, sourceName) =>
        parseAeroFriedrichshafenPage(html, page.url, sourceName),
    }),
  ];
}
