import { config } from "../config.js";
import { upsertPartsListing } from "../db/parts.js";
import { startCrawlRun, completeCrawlRun, failCrawlRun } from "../db/crawler-runs.js";
import { getSystemUserId } from "../db/system-user.js";
import { parsePartsPage } from "../parsers/parts.js";
import type { CrawlResult } from "../types.js";
import { delay, fetchPage } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl all parts listing pages from Helmut's UL Seiten,
 * parse them, and upsert into Supabase.
 */
export async function crawlParts(): Promise<CrawlResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const warnings: string[] = [];
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  const dbRunId = await startCrawlRun(config.sources.helmut.name, "parts");

  logger.info("Starting parts crawl", { dbRunId });

  try {
    const systemUserId = await getSystemUserId();
    const urls = config.sources.helmut.parts;

    for (const url of urls) {
      try {
        const html = await fetchPage(url);
        const listings = parsePartsPage(html, url, config.sources.helmut.name);
        listingsFound += listings.length;

        for (const listing of listings) {
          const result = await upsertPartsListing(listing, systemUserId);
          switch (result) {
            case "inserted":
              listingsInserted++;
              break;
            case "updated":
              listingsUpdated++;
              break;
            case "skipped":
              listingsSkipped++;
              break;
          }
        }

        await delay();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${url}: ${msg}`);
        logger.error("Failed to crawl parts page", { url, error: msg });
      }
    }

    if (dbRunId) {
      await completeCrawlRun(
        dbRunId,
        {
          pagesProcessed: urls.length,
          listingsFound,
          listingsInserted,
          listingsUpdated,
          listingsSkipped,
          errors: errors.length,
          imagesUploaded: listingsInserted,
          translationsCompleted: listingsInserted + listingsUpdated,
        },
        startTime,
        warnings
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (dbRunId) await failCrawlRun(dbRunId, msg, startTime);
    throw err;
  }

  const result: CrawlResult = {
    runId: dbRunId ?? `parts-${startTime}`,
    source: config.sources.helmut.name,
    target: "parts",
    startedAt,
    completedAt: new Date().toISOString(),
    pagesProcessed: config.sources.helmut.parts.length,
    listingsFound,
    listingsInserted,
    listingsUpdated,
    listingsSkipped,
    errors,
  };

  logger.info("Parts crawl completed", {
    found: listingsFound,
    inserted: listingsInserted,
    updated: listingsUpdated,
    skipped: listingsSkipped,
    errors: errors.length,
  });

  return result;
}
