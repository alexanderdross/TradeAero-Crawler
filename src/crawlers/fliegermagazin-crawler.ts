import { config } from "../config.js";
import {
  parseFliegermagazinPage,
  parseFliegermagazinTotalPages,
} from "../parsers/fliegermagazin.js";
import { fetchPage } from "../utils/fetch.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl fliegermagazin.de /termine/. Paginated source — page 1 is the
 * canonical entry; page count is discovered at runtime by reading the
 * "Seite N von M" indicator. Pages 2..M are appended to the crawl plan
 * dynamically.
 *
 * Cloudflare CDN sits in front but the response is cacheable and the
 * default Chrome-131 UA passes through. We never advertise as
 * ClaudeBot / GPTBot — fliegermagazin's robots.txt explicitly
 * Disallows them.
 */
export async function crawlFliegermagazin(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`fliegermagazin has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.fliegermagazin;
  const entryUrls = src.events ?? [];

  // Discover total page count from page 1 of each entry URL up-front
  // so the orchestrator's per-page loop sees every page as a normal
  // EventCrawlPage (with its own error isolation + delay).
  const pages: { url: string }[] = [];
  for (const entry of entryUrls) {
    pages.push({ url: entry });
    try {
      const html = await fetchPage(entry, { proxy: src.useProxy });
      const total = parseFliegermagazinTotalPages(html);
      logger.info("fliegermagazin pagination discovered", { entry, total });
      // Append pages 2..total. Cap at 20 for sanity in case the
      // page-count parser misbehaves; cap is also enforced in the
      // parser helper.
      const ceiling = Math.min(total, 20);
      for (let i = 2; i <= ceiling; i++) {
        // Strip trailing slash before appending so we land on
        // /termine/seite/2/ regardless of input shape.
        const trimmed = entry.replace(/\/$/, "");
        pages.push({ url: `${trimmed}/seite/${i}/` });
      }
    } catch (err) {
      logger.warn(
        "fliegermagazin pagination probe failed — proceeding with page 1 only",
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
        parseFliegermagazinPage(html, page.url, sourceName),
    }),
  ];
}
