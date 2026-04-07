import { config } from "../config.js";
import { upsertAircraftListing } from "../db/aircraft.js";
import { upsertPartsListing } from "../db/parts.js";
import { startCrawlRun, completeCrawlRun, failCrawlRun } from "../db/crawler-runs.js";
import { getSystemUserId } from "../db/system-user.js";
import { parseAircraftPage } from "../parsers/helmut-aircraft.js";
import { parsePartsPage } from "../parsers/helmut-parts.js";
import type { CrawlResult } from "../types.js";
import { delay, fetchPage, getProxyBytesTransferred, resetProxyBytesTransferred } from "../utils/fetch.js";
import { getTranslationTokenUsage, resetTranslationTokenUsage } from "../utils/translate.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl Helmut's UL Seiten — aircraft and/or parts.
 */
export async function crawlHelmut(target: "aircraft" | "parts" | "all"): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];

  if (target === "aircraft" || target === "all") {
    results.push(await crawlHelmutAircraft());
  }
  if (target === "parts" || target === "all") {
    results.push(await crawlHelmutParts());
  }

  return results;
}

async function crawlHelmutAircraft(): Promise<CrawlResult> {
  const src = config.sources.helmut;
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  const dbRunId = await startCrawlRun(src.name, "aircraft");
  resetProxyBytesTransferred();
  resetTranslationTokenUsage();
  logger.info("Starting Helmut aircraft crawl", { dbRunId });

  try {
    const systemUserId = await getSystemUserId();

    for (const url of src.aircraft) {
      try {
        const html = await fetchPage(url, { proxy: src.useProxy });
        const listings = parseAircraftPage(html, url, src.name);
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
        errors.push(`${url}: ${msg}`);
        logger.error("Failed to crawl Helmut aircraft page", { url, error: msg });
      }
    }

    const warnings: string[] = [];
    if (listingsFound === 0 && errors.length === 0) {
      const warn = `[CRAWLER] WARNING: 0 listings parsed from ${src.name} - possible site structure change`;
      logger.warn(warn);
      warnings.push(warn);
    }

    if (dbRunId) {
      const tokens = getTranslationTokenUsage();
      await completeCrawlRun(dbRunId, {
        pagesProcessed: src.aircraft.length, listingsFound, listingsInserted,
        listingsUpdated, listingsSkipped, errors: errors.length,
        imagesUploaded: listingsInserted, translationsCompleted: listingsInserted + listingsUpdated,
        proxyBytesTransferred: getProxyBytesTransferred(),
        translationInputTokens: tokens.input, translationOutputTokens: tokens.output,
      }, startTime, warnings);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (dbRunId) await failCrawlRun(dbRunId, msg, startTime);
    throw err;
  }

  logger.info("Helmut aircraft crawl completed", { found: listingsFound, inserted: listingsInserted, updated: listingsUpdated, skipped: listingsSkipped, errors: errors.length });

  return { runId: dbRunId ?? `helmut-aircraft-${startTime}`, source: src.name, target: "aircraft", startedAt, completedAt: new Date().toISOString(), pagesProcessed: src.aircraft.length, listingsFound, listingsInserted, listingsUpdated, listingsSkipped, errors };
}

async function crawlHelmutParts(): Promise<CrawlResult> {
  const src = config.sources.helmut;
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;

  const dbRunId = await startCrawlRun(src.name, "parts");
  resetProxyBytesTransferred();
  resetTranslationTokenUsage();
  logger.info("Starting Helmut parts crawl", { dbRunId });

  try {
    const systemUserId = await getSystemUserId();

    for (const url of src.parts) {
      try {
        const html = await fetchPage(url, { proxy: src.useProxy });
        const listings = parsePartsPage(html, url, src.name);
        listingsFound += listings.length;

        for (const listing of listings) {
          const result = await upsertPartsListing(listing, systemUserId);
          switch (result) {
            case "inserted": listingsInserted++; break;
            case "updated": listingsUpdated++; break;
            case "skipped": listingsSkipped++; break;
          }
        }
        await delay();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${url}: ${msg}`);
        logger.error("Failed to crawl Helmut parts page", { url, error: msg });
      }
    }

    const warnings: string[] = [];
    if (listingsFound === 0 && errors.length === 0) {
      const warn = `[CRAWLER] WARNING: 0 listings parsed from ${src.name} - possible site structure change`;
      logger.warn(warn);
      warnings.push(warn);
    }

    if (dbRunId) {
      const tokens = getTranslationTokenUsage();
      await completeCrawlRun(dbRunId, {
        pagesProcessed: src.parts.length, listingsFound, listingsInserted,
        listingsUpdated, listingsSkipped, errors: errors.length,
        imagesUploaded: listingsInserted, translationsCompleted: listingsInserted + listingsUpdated,
        proxyBytesTransferred: getProxyBytesTransferred(),
        translationInputTokens: tokens.input, translationOutputTokens: tokens.output,
      }, startTime, warnings);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (dbRunId) await failCrawlRun(dbRunId, msg, startTime);
    throw err;
  }

  logger.info("Helmut parts crawl completed", { found: listingsFound, inserted: listingsInserted, updated: listingsUpdated, skipped: listingsSkipped, errors: errors.length });

  return { runId: dbRunId ?? `helmut-parts-${startTime}`, source: src.name, target: "parts", startedAt, completedAt: new Date().toISOString(), pagesProcessed: src.parts.length, listingsFound, listingsInserted, listingsUpdated, listingsSkipped, errors };
}
