import { config, type IcsCalendar } from "../config.js";
import { parseIcsCalendar } from "../parsers/ics.js";
import { upsertEvent } from "../db/events.js";
import {
  startCrawlRun,
  completeCrawlRun,
  failCrawlRun,
} from "../db/crawler-runs.js";
import { fetchPage, getProxyBytesTransferred, resetProxyBytesTransferred, delay } from "../utils/fetch.js";
import {
  getTranslationTokenUsage,
  resetTranslationTokenUsage,
} from "../utils/translate.js";
import { logger } from "../utils/logger.js";
import type { CrawlResult } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Generic ICS-feed crawler.
//
// Loops over every entry in `config.sources.ics.calendars`, fetches the
// `.ics` payload with the standard fetchPage retry/backoff, parses with
// `parseIcsCalendar`, and upserts via the same `upsertEvent` Vereinsflieger
// uses (so the bilingual-min translation policy + content-hash dedup
// applies uniformly).
//
// One run logs ONE row in `crawler_runs` — per-calendar fan-out is rolled
// up into the aggregate stats. Per-calendar errors are captured in the
// errors array but do NOT fail the run; one bad feed shouldn't block the
// other 9.
// ─────────────────────────────────────────────────────────────────────────────

export async function crawlIcs(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`ICS crawler has no ${target} target — skipping`);
    return [];
  }
  return [await crawlIcsEvents()];
}

async function fetchOneCalendar(cal: IcsCalendar): Promise<{
  events: ReturnType<typeof parseIcsCalendar>;
  bytes: number;
}> {
  // ICS payloads are usually small (<200 KB) plain text. fetchPage already
  // tracks proxy bytes; we delegate so the admin cost card covers ICS too.
  const text = await fetchPage(cal.url, { proxy: false });
  const events = parseIcsCalendar(text, cal, "ics-feed");
  return { events, bytes: text.length };
}

async function crawlIcsEvents(): Promise<CrawlResult> {
  const src = config.sources.ics;
  const calendars = src.calendars ?? [];
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let listingsFound = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;
  let listingsSkipped = 0;
  let pagesProcessed = 0;

  const dbRunId = await startCrawlRun(src.name, "events");
  resetProxyBytesTransferred();
  resetTranslationTokenUsage();

  if (calendars.length === 0) {
    logger.info(
      "ICS crawler started with empty calendar list — populate config.sources.ics.calendars to ingest events",
    );
  } else {
    logger.info("Starting ICS crawl", { dbRunId, calendars: calendars.length });
  }

  try {
    for (const cal of calendars) {
      try {
        const { events } = await fetchOneCalendar(cal);
        pagesProcessed += 1;
        listingsFound += events.length;
        logger.info(`Parsed ICS calendar`, {
          calendar: cal.name,
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
            errors.push(`${cal.name} :: ${ev.sourceUrl}: ${msg}`);
            logger.error("Failed to upsert ICS event", {
              calendar: cal.name,
              uid: ev.sourceUrl,
              error: msg,
            });
          }
        }
        // Be polite to ICS hosts — many are small club servers.
        await delay();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${cal.name} (${cal.url}): ${msg}`);
        logger.error("Failed to fetch/parse ICS calendar", {
          calendar: cal.name,
          url: cal.url,
          error: msg,
        });
      }
    }

    const warnings: string[] = [];
    if (calendars.length > 0 && listingsFound === 0 && errors.length === 0) {
      const w = `[CRAWLER] WARNING: 0 events parsed across ${calendars.length} ICS calendars — possible feed structure change or empty calendars`;
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

  logger.info("ICS crawl completed", {
    found: listingsFound,
    inserted: listingsInserted,
    updated: listingsUpdated,
    skipped: listingsSkipped,
    errors: errors.length,
  });

  return {
    runId: dbRunId ?? `ics-events-${startTime}`,
    source: src.name,
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
