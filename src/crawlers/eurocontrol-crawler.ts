import { config } from "../config.js";
import {
  parseEurocontrolPage,
  parseEurocontrolLastPageIndex,
} from "../parsers/eurocontrol.js";
import { fetchPage } from "../utils/fetch.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl eurocontrol.int /events. Drupal pager uses 0-indexed
 * `?page=N` query strings; the default URL is page 0. We probe page 0
 * once on entry, read off the highest pager index, and append pages
 * 1..N to the run plan.
 *
 * Cloudflare CDN sits in front (`cf-cache-status: DYNAMIC`) — `useProxy:
 * true` defends against rate-limit 503s from cloud IPs.
 */
export async function crawlEurocontrol(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`eurocontrol has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.eurocontrol;
  const entryUrls = src.events ?? [];

  const pages: { url: string }[] = [];
  for (const entry of entryUrls) {
    pages.push({ url: entry });
    try {
      const html = await fetchPage(entry, { proxy: src.useProxy });
      const lastIndex = parseEurocontrolLastPageIndex(html);
      logger.info("eurocontrol pagination discovered", { entry, lastIndex });
      for (let i = 1; i <= lastIndex; i++) {
        const sep = entry.includes("?") ? "&" : "?";
        pages.push({ url: `${entry}${sep}page=${i}` });
      }
    } catch (err) {
      logger.warn(
        "eurocontrol pagination probe failed — proceeding with first page only",
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
        parseEurocontrolPage(html, page.url, sourceName),
    }),
  ];
}
