import { config } from "../config.js";
import { parseDulvPage, parseDulvLastPageIndex } from "../parsers/dulv.js";
import { fetchPage } from "../utils/fetch.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl dulv.de /Veranstaltungen. Drupal pager uses 0-indexed
 * `?page=N` query strings; the default URL is page 0. We probe page 0
 * once on entry, read off the highest pager index, and append pages
 * 1..N to the run plan.
 *
 * No proxy required — Apache, no Cloudflare, no captcha.
 */
export async function crawlDulv(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`dulv has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.dulv;
  const entryUrls = src.events ?? [];

  const pages: { url: string }[] = [];
  for (const entry of entryUrls) {
    pages.push({ url: entry });
    try {
      const html = await fetchPage(entry, { proxy: src.useProxy });
      const lastIndex = parseDulvLastPageIndex(html);
      logger.info("dulv pagination discovered", { entry, lastIndex });
      // lastIndex is 0-based — value of 1 means two total pages
      // (page 0 default + ?page=1). Cap at 9 (10 pages × ~10 events ≈
      // 100 rows) for sanity; the parser already enforces the same cap.
      for (let i = 1; i <= lastIndex; i++) {
        const sep = entry.includes("?") ? "&" : "?";
        pages.push({ url: `${entry}${sep}page=${i}` });
      }
    } catch (err) {
      logger.warn(
        "dulv pagination probe failed — proceeding with first page only",
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
        parseDulvPage(html, page.url, sourceName),
    }),
  ];
}
