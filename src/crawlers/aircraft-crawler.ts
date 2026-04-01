import { config } from "../config.js";
import { upsertAircraftListing } from "../db/aircraft.js";
import { getSystemUserId } from "../db/system-user.js";
import { parseAircraftPage } from "../parsers/aircraft.js";
import type { CrawlResult } from "../types.js";
import { delay, fetchPage } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl all aircraft listing pages from Helmut's UL Seiten,
 * parse them, and upsert into Supabase.
 */
export async function crawlAircraft(): Promise<CrawlResult> {
  const runId = `aircraft-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  logger.info("Starting aircraft crawl", { runId });

  const systemUserId = await getSystemUserId();
  const urls = config.sources.helmut.aircraft;

  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const listings = parseAircraftPage(html, url, config.sources.helmut.name);
      listingsFound += listings.length;

      for (const listing of listings) {
        const result = await upsertAircraftListing(listing, systemUserId);
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

      // Polite delay between pages
      await delay();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${url}: ${msg}`);
      logger.error("Failed to crawl aircraft page", { url, error: msg });
    }
  }

  const result: CrawlResult = {
    runId,
    source: config.sources.helmut.name,
    target: "aircraft",
    startedAt,
    completedAt: new Date().toISOString(),
    pagesProcessed: urls.length,
    listingsFound,
    listingsInserted,
    listingsUpdated,
    listingsSkipped,
    errors,
  };

  logger.info("Aircraft crawl completed", {
    runId,
    found: listingsFound,
    inserted: listingsInserted,
    updated: listingsUpdated,
    skipped: listingsSkipped,
    errors: errors.length,
  });

  return result;
}
