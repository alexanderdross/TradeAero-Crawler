import { upsertEvent } from "../db/events.js";
import {
  startCrawlRun,
  completeCrawlRun,
  failCrawlRun,
} from "../db/crawler-runs.js";
import {
  delay,
  fetchPage,
  getProxyBytesTransferred,
  resetProxyBytesTransferred,
} from "../utils/fetch.js";
import {
  getTranslationTokenUsage,
  resetTranslationTokenUsage,
} from "../utils/translate.js";
import { logger } from "../utils/logger.js";
import type { CrawlResult, ParsedEvent } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reusable event-crawler orchestrator.
//
// Captures the boilerplate every bespoke event crawler needs (start run,
// fetch page, parse, upsert each row, complete run, return CrawlResult)
// so a new source is genuinely a "1-day clone of Vereinsflieger" — write
// a parser function and a config entry, hand the pair to runEventCrawler,
// done.
//
// Both `vereinsflieger-crawler.ts` and `ics-crawler.ts` delegate here so
// the orchestrator stays tested in one place. Per-source quirks (proxy,
// payload type, parser signature) live in the lambda the caller passes.
// ─────────────────────────────────────────────────────────────────────────────

export interface EventCrawlPage<TPayload = unknown> {
  /** Public-facing URL. Used as the human-readable page reference and as
   *  the dedup-key prefix for events the parser emits. */
  url: string;
  /** Optional opaque payload threaded through to the parser (e.g. an
   *  IcsCalendar describing the per-feed defaults). Ignored when the
   *  parser doesn't need extra context. */
  meta?: TPayload;
  /** Skip this page if true. Lets callers gate per-URL without dropping
   *  it from the list (useful for ToS holds / temporary outages). */
  disabled?: boolean;
}

export interface EventCrawlerConfig<TPayload = unknown> {
  /** Source name written to crawler_runs.source_name. e.g. "dulv.de" */
  sourceName: string;
  /** Pages to fetch + parse on this run. */
  pages: EventCrawlPage<TPayload>[];
  /** Whether to route fetches through Bright Data. Most public event
   *  pages don't need it (no anti-bot); passed through to fetchPage. */
  useProxy?: boolean;
  /** Fetcher override. Defaults to fetchPage(url, { proxy }) which gives
   *  us retry / proxy / byte-tracking. Override for ICS or other
   *  text-payload formats that have non-HTML quirks. */
  fetcher?: (url: string, useProxy: boolean) => Promise<string>;
  /** Parse one fetched page into ParsedEvent rows. */
  parsePage: (
    payload: string,
    page: EventCrawlPage<TPayload>,
    sourceName: string,
  ) => ParsedEvent[];
  /** Optional pre-flight log line context. */
  startContext?: Record<string, unknown>;
}

/**
 * Run one bespoke event crawler end-to-end.
 *
 * Per-page failures are captured in `errors[]` but never abort the run —
 * one bad URL shouldn't block the others. A run-level catastrophe (DB
 * unreachable, etc.) does fail the run via `failCrawlRun`.
 *
 * Returns the same CrawlResult shape `crawl{Helmut|Aircraft24|…}` use, so
 * the admin dashboard's run-history tab renders it without special-casing.
 */
export async function runEventCrawler<TPayload = unknown>(
  cfg: EventCrawlerConfig<TPayload>,
): Promise<CrawlResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;
  let pagesProcessed = 0;

  const dbRunId = await startCrawlRun(cfg.sourceName, "events");
  resetProxyBytesTransferred();
  resetTranslationTokenUsage();

  const enabledPages = cfg.pages.filter((p) => !p.disabled);
  if (enabledPages.length === 0) {
    logger.info(`${cfg.sourceName} crawler started with no enabled pages`, {
      configured: cfg.pages.length,
    });
  } else {
    logger.info(`Starting ${cfg.sourceName} events crawl`, {
      dbRunId,
      pages: enabledPages.length,
      ...cfg.startContext,
    });
  }

  const fetchOne =
    cfg.fetcher ??
    ((url: string, useProxy: boolean) => fetchPage(url, { proxy: useProxy }));

  try {
    for (const page of enabledPages) {
      try {
        const payload = await fetchOne(page.url, cfg.useProxy ?? false);
        const events = cfg.parsePage(payload, page, cfg.sourceName);
        pagesProcessed += 1;
        listingsFound += events.length;
        logger.info(`Parsed page`, {
          source: cfg.sourceName,
          url: page.url,
          events: events.length,
        });

        for (const ev of events) {
          try {
            const result = await upsertEvent(ev);
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
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${ev.sourceUrl}: ${msg}`);
            logger.error("Failed to upsert event", {
              source: cfg.sourceName,
              sourceUrl: ev.sourceUrl,
              error: msg,
            });
          }
        }
        await delay();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${page.url}: ${msg}`);
        logger.error("Failed to fetch/parse page", {
          source: cfg.sourceName,
          url: page.url,
          error: msg,
        });
      }
    }

    const warnings: string[] = [];
    if (
      enabledPages.length > 0 &&
      listingsFound === 0 &&
      errors.length === 0
    ) {
      const w = `[CRAWLER] WARNING: 0 events parsed from ${cfg.sourceName} - possible site structure change`;
      logger.warn(w);
      warnings.push(w);
    }

    if (dbRunId) {
      const tokens = getTranslationTokenUsage();
      await completeCrawlRun(
        dbRunId,
        {
          pagesProcessed,
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

  logger.info(`${cfg.sourceName} events crawl completed`, {
    found: listingsFound,
    inserted: listingsInserted,
    updated: listingsUpdated,
    skipped: listingsSkipped,
    errors: errors.length,
  });

  return {
    runId: dbRunId ?? `${cfg.sourceName}-events-${startTime}`,
    source: cfg.sourceName,
    target: "events",
    startedAt,
    completedAt: new Date().toISOString(),
    pagesProcessed,
    listingsFound,
    listingsInserted,
    listingsUpdated,
    listingsSkipped,
    errors,
  };
}
