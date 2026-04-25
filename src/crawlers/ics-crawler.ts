import { config, type IcsCalendar } from "../config.js";
import { parseIcsCalendar } from "../parsers/ics.js";
import { runEventCrawler } from "./run-event-crawler.js";
import { logger } from "../utils/logger.js";
import type { CrawlResult } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Generic ICS-feed crawler.
//
// Loops over every entry in `config.sources.ics.calendars`, fetches the
// `.ics` payload, parses with `parseIcsCalendar`, and upserts via the
// shared events pipeline (so the bilingual-min translation policy +
// content-hash dedup applies uniformly).
//
// One run logs ONE row in `crawler_runs` — per-calendar fan-out is rolled
// up into the aggregate stats. Per-calendar errors are captured but do
// NOT fail the run; one bad feed shouldn't block the other 9.
// ─────────────────────────────────────────────────────────────────────────────

export async function crawlIcs(
  target: "aircraft" | "parts" | "events" | "all",
): Promise<CrawlResult[]> {
  if (target === "aircraft" || target === "parts") {
    logger.warn(`ICS crawler has no ${target} target — skipping`);
    return [];
  }
  const src = config.sources.ics;
  return [
    await runEventCrawler<IcsCalendar>({
      sourceName: src.name,
      pages: (src.calendars ?? []).map((cal) => ({ url: cal.url, meta: cal })),
      useProxy: false,
      parsePage: (text, page, sourceName) => {
        if (!page.meta) return [];
        return parseIcsCalendar(text, page.meta, sourceName);
      },
      startContext: { calendars: (src.calendars ?? []).length },
    }),
  ];
}
