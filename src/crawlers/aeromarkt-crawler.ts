import { config } from "../config.js";
import { upsertAircraftListing } from "../db/aircraft.js";
import { upsertPartsListing } from "../db/parts.js";
import { startCrawlRun, completeCrawlRun, failCrawlRun } from "../db/crawler-runs.js";
import { getSystemUserId } from "../db/system-user.js";
import { parseAeromarktAircraftPage, parseAeromarktPartsPage } from "../parsers/aeromarkt.js";
import type { CrawlResult } from "../types.js";
import { delay, fetchPage } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl aeromarkt.net — aircraft and parts.
 *
 * TODO: Parsers need calibration against live HTML once accessible
 * via Bright Data proxy. Current selectors are best-guess.
 */
export async function crawlAeromarkt(target: "aircraft" | "parts" | "all"): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];

  if (target === "aircraft" || target === "all") {
    results.push(await crawlAeromarktAircraft());
  }
  if (target === "parts" || target === "all") {
    results.push(await crawlAeromarktParts());
  }

  return results;
}

async function crawlAeromarktAircraft(): Promise<CrawlResult> {
  const src = config.sources.aeromarkt;
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let pagesProcessed = 0;
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  const dbRunId = await startCrawlRun(src.name, "aircraft");
  logger.info("Starting aeromarkt.net aircraft crawl", { dbRunId });

  try {
    const systemUserId = await getSystemUserId();

    for (const categoryUrl of src.aircraft) {
      let currentUrl: string | null = categoryUrl;
      let pageCount = 0;
      const maxPages = 20;

      while (currentUrl && pageCount < maxPages) {
        try {
          const html = await fetchPage(currentUrl, { proxy: src.useProxy });
          pagesProcessed++;
          pageCount++;

          const { listings, nextPageUrl } = parseAeromarktAircraftPage(html, currentUrl, src.name);
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
          logger.error("Failed to crawl aeromarkt aircraft page", { url: currentUrl, error: msg });
          currentUrl = null;
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

  logger.info("aeromarkt.net aircraft crawl completed", { pages: pagesProcessed, found: listingsFound, inserted: listingsInserted, updated: listingsUpdated, skipped: listingsSkipped, errors: errors.length });

  return { runId: dbRunId ?? `aeromarkt-aircraft-${startTime}`, source: src.name, target: "aircraft", startedAt, completedAt: new Date().toISOString(), pagesProcessed, listingsFound, listingsInserted, listingsUpdated, listingsSkipped, errors };
}

async function crawlAeromarktParts(): Promise<CrawlResult> {
  const src = config.sources.aeromarkt;
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let pagesProcessed = 0;
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  const dbRunId = await startCrawlRun(src.name, "parts");
  logger.info("Starting aeromarkt.net parts crawl", { dbRunId });

  try {
    const systemUserId = await getSystemUserId();

    for (const categoryUrl of src.parts) {
      let currentUrl: string | null = categoryUrl;
      let pageCount = 0;
      const maxPages = 20;

      while (currentUrl && pageCount < maxPages) {
        try {
          const html = await fetchPage(currentUrl, { proxy: src.useProxy });
          pagesProcessed++;
          pageCount++;

          const { listings, nextPageUrl } = parseAeromarktPartsPage(html, currentUrl, src.name);
          listingsFound += listings.length;

          for (const listing of listings) {
            const result = await upsertPartsListing(listing, systemUserId);
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
          logger.error("Failed to crawl aeromarkt parts page", { url: currentUrl, error: msg });
          currentUrl = null;
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

  logger.info("aeromarkt.net parts crawl completed", { pages: pagesProcessed, found: listingsFound, inserted: listingsInserted, updated: listingsUpdated, skipped: listingsSkipped, errors: errors.length });

  return { runId: dbRunId ?? `aeromarkt-parts-${startTime}`, source: src.name, target: "parts", startedAt, completedAt: new Date().toISOString(), pagesProcessed, listingsFound, listingsInserted, listingsUpdated, listingsSkipped, errors };
}
