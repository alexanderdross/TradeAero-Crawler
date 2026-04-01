import { config } from "../config.js";
import { upsertAircraftListing } from "../db/aircraft.js";
import { startCrawlRun, completeCrawlRun, failCrawlRun } from "../db/crawler-runs.js";
import { getSystemUserId } from "../db/system-user.js";
import { parseAircraft24IndexPage, parseAircraft24ModelPage } from "../parsers/aircraft24.js";
import type { CrawlResult } from "../types.js";
import { delay, fetchPage } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl aircraft24.de — aircraft only (no parts section on this site).
 *
 * Strategy:
 * 1. Fetch each category index page (singleprop, multiprop, etc.)
 * 2. Extract model page URLs from index
 * 3. For each model page, parse listings (with pagination)
 * 4. Upsert each listing through the standard pipeline
 */
export async function crawlAircraft24(target: "aircraft" | "parts" | "all"): Promise<CrawlResult[]> {
  if (target === "parts") {
    logger.info("aircraft24.de has no parts section, skipping");
    return [];
  }

  const results: CrawlResult[] = [];
  results.push(await crawlAircraft24Aircraft());
  return results;
}

async function crawlAircraft24Aircraft(): Promise<CrawlResult> {
  const src = config.sources.aircraft24;
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let pagesProcessed = 0;
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  const dbRunId = await startCrawlRun(src.name, "aircraft");
  logger.info("Starting aircraft24.de crawl", { dbRunId });

  try {
    const systemUserId = await getSystemUserId();
    const allModelUrls: string[] = [];

    // Step 1: Fetch category index pages to discover model URLs
    for (const indexUrl of src.aircraft) {
      try {
        const html = await fetchPage(indexUrl, { proxy: src.useProxy });
        pagesProcessed++;
        const { modelUrls, listings } = parseAircraft24IndexPage(html, indexUrl, src.name);
        allModelUrls.push(...modelUrls);

        // Process any listings found directly on index pages
        listingsFound += listings.length;
        for (const listing of listings) {
          const result = await upsertAircraftListing(listing, systemUserId);
          switch (result) {
            case "inserted": listingsInserted++; break;
            case "updated": listingsUpdated++; break;
            case "skipped": listingsSkipped++; break;
          }
        }

        await delay();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${indexUrl}: ${msg}`);
        logger.error("Failed to crawl aircraft24 index", { url: indexUrl, error: msg });
      }
    }

    logger.info(`Discovered ${allModelUrls.length} model pages`, { source: src.name });

    // Step 2: Crawl each model page (with pagination)
    for (const modelUrl of allModelUrls) {
      let currentUrl: string | null = modelUrl;
      let pageCount = 0;
      const maxPages = 10; // Safety limit per model

      while (currentUrl && pageCount < maxPages) {
        try {
          const html = await fetchPage(currentUrl, { proxy: src.useProxy });
          pagesProcessed++;
          pageCount++;

          const { listings, nextPageUrl } = parseAircraft24ModelPage(html, currentUrl, src.name);
          listingsFound += listings.length;

          for (const listing of listings) {
            const result = await upsertAircraftListing(listing, systemUserId);
            switch (result) {
              case "inserted": listingsInserted++; break;
              case "updated": listingsUpdated++; break;
              case "skipped": listingsSkipped++; break;
            }
          }

          currentUrl = nextPageUrl;
          await delay();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${currentUrl}: ${msg}`);
          logger.error("Failed to crawl aircraft24 model page", { url: currentUrl, error: msg });
          currentUrl = null; // Stop pagination on error
        }
      }
    }

    if (dbRunId) {
      await completeCrawlRun(dbRunId, {
        pagesProcessed, listingsFound, listingsInserted,
        listingsUpdated, listingsSkipped, errors: errors.length,
        imagesUploaded: listingsInserted, translationsCompleted: listingsInserted + listingsUpdated,
      }, startTime);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (dbRunId) await failCrawlRun(dbRunId, msg, startTime);
    throw err;
  }

  logger.info("aircraft24.de crawl completed", { pages: pagesProcessed, found: listingsFound, inserted: listingsInserted, updated: listingsUpdated, skipped: listingsSkipped, errors: errors.length });

  return { runId: dbRunId ?? `aircraft24-${startTime}`, source: src.name, target: "aircraft", startedAt, completedAt: new Date().toISOString(), pagesProcessed, listingsFound, listingsInserted, listingsUpdated, listingsSkipped, errors };
}
