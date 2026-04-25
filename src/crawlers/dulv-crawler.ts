import { config } from "../config.js";
import {
  parseDulvPage,
  parseDulvLastPageIndex,
  extractDulvDetailTitle,
} from "../parsers/dulv.js";
import { fetchPage } from "../utils/fetch.js";
import { runEventCrawler } from "./run-event-crawler.js";
import type { CrawlResult, ParsedEvent } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl dulv.de /Veranstaltungen. Drupal pager uses 0-indexed
 * `?page=N` query strings; the default URL is page 0. We probe page 0
 * once on entry, read off the highest pager index, and append pages
 * 1..N to the run plan.
 *
 * Listing pages don't carry a per-row title heading — only the image
 * alt attribute, which is sometimes a filename like "Waffelflyin" rather
 * than the human-typed event name. The enricher fetches each event's
 * `/node/N` detail page and replaces the heuristic title with the
 * canonical `<h1 class="page-title">` text. Detail-page fetch failures
 * are swallowed so one bad URL doesn't drop the row.
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
      enrichEvents: enrichDulvEventsWithDetailTitles,
    }),
  ];
}

/**
 * For each event, fetch its `/node/N` detail page and replace the
 * listing-page heuristic title with `<h1 class="page-title">` text.
 *
 * Sequential fetches with the runEventCrawler's own polite delay don't
 * apply here, so we do an in-loop short delay to keep total request
 * pressure low — DULV is a small site (Microsoft IIS / Drupal) and we
 * shouldn't hammer it.
 *
 * Detail-page failures are swallowed: the original heuristic title is
 * kept so the row still lands. We log a warn so operators can spot
 * bursts of failures (e.g. site outage).
 */
export async function enrichDulvEventsWithDetailTitles(
  events: ParsedEvent[],
  _page: { url: string },
  useProxy: boolean,
): Promise<ParsedEvent[]> {
  const enriched: ParsedEvent[] = [];
  let replaced = 0;
  let failed = 0;
  for (const ev of events) {
    try {
      const html = await fetchPage(ev.sourceUrl, { proxy: useProxy });
      const cleanTitle = extractDulvDetailTitle(html);
      if (cleanTitle && cleanTitle !== ev.title) {
        replaced++;
        enriched.push({ ...ev, title: cleanTitle });
      } else {
        enriched.push(ev);
      }
    } catch (err) {
      failed++;
      logger.warn("dulv detail-page fetch failed — keeping listing-page title", {
        sourceUrl: ev.sourceUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      enriched.push(ev);
    }
    // Short polite delay between detail fetches. 500ms keeps DULV
    // happy without blowing the cron-window budget — 20 events × 0.5s
    // = 10s overhead.
    await new Promise((r) => setTimeout(r, 500));
  }
  if (replaced > 0 || failed > 0) {
    logger.info("dulv detail-page enrichment summary", {
      total: events.length,
      replaced,
      failed,
    });
  }
  return enriched;
}
