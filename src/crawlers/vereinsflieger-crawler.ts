import { config } from "../config.js";
import { upsertEvent } from "../db/events.js";
import { startCrawlRun, completeCrawlRun, failCrawlRun } from "../db/crawler-runs.js";
import { parseVereinsfliegerPage } from "../parsers/vereinsflieger.js";
import type { CrawlResult } from "../types.js";
import { delay, fetchPage, getProxyBytesTransferred, resetProxyBytesTransferred } from "../utils/fetch.js";
import { getTranslationTokenUsage, resetTranslationTokenUsage } from "../utils/translate.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl vereinsflieger.de/publiccalendar. The only supported target is
 * `events` — aircraft/parts URLs are left empty in SourceConfig so
 * `crawlVereinsflieger("all")` is equivalent to `crawlVereinsflieger("events")`.
 */
export async function crawlVereinsflieger(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`Vereinsflieger has no ${target} target — skipping`);
    return [];
  }
  return [await crawlVereinsfliegerEvents()];
}

async function crawlVereinsfliegerEvents(): Promise<CrawlResult> {
  const src = config.sources.vereinsflieger;
  const urls = src.events ?? [];
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  const dbRunId = await startCrawlRun(src.name, "events");
  resetProxyBytesTransferred();
  resetTranslationTokenUsage();
  logger.info("Starting Vereinsflieger events crawl", { dbRunId, urls: urls.length });

  try {
    for (const url of urls) {
      try {
        const html = await fetchPage(url, { proxy: src.useProxy });
        const events = parseVereinsfliegerPage(html, url, src.name);
        listingsFound += events.length;

        for (const event of events) {
          try {
            const result = await upsertEvent(event);
            switch (result) {
              case "inserted": listingsInserted++; break;
              case "updated": listingsUpdated++; break;
              case "skipped": listingsSkipped++; break;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${event.sourceUrl}: ${msg}`);
            logger.error("Failed to upsert event", { sourceUrl: event.sourceUrl, error: msg });
          }
        }
        await delay();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${url}: ${msg}`);
        logger.error("Failed to crawl Vereinsflieger category page", { url, error: msg });
      }
    }

    const warnings: string[] = [];
    if (listingsFound === 0 && errors.length === 0) {
      const warn = `[CRAWLER] WARNING: 0 events parsed from ${src.name} - possible site structure change`;
      logger.warn(warn);
      warnings.push(warn);
    }

    if (dbRunId) {
      const tokens = getTranslationTokenUsage();
      await completeCrawlRun(
        dbRunId,
        {
          pagesProcessed: urls.length,
          listingsFound,
          listingsInserted,
          listingsUpdated,
          listingsSkipped,
          errors: errors.length,
          imagesUploaded: 0,
          translationsCompleted: listingsInserted + listingsUpdated,
          proxyBytesTransferred: getProxyBytesTransferred(),
          translationInputTokens: tokens.input,
          translationOutputTokens: tokens.output,
        },
        startTime,
        warnings,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (dbRunId) await failCrawlRun(dbRunId, msg, startTime);
    throw err;
  }

  logger.info("Vereinsflieger events crawl completed", {
    found: listingsFound,
    inserted: listingsInserted,
    updated: listingsUpdated,
    skipped: listingsSkipped,
    errors: errors.length,
  });

  return {
    runId: dbRunId ?? `vereinsflieger-events-${startTime}`,
    source: src.name,
    target: "events",
    startedAt,
    completedAt: new Date().toISOString(),
    pagesProcessed: urls.length,
    listingsFound,
    listingsInserted,
    listingsUpdated,
    listingsSkipped,
    errors,
  };
}
