import { config, type IcsCalendar } from "../config.js";
import { parseIcsCalendar } from "../parsers/ics.js";
import { runEventCrawler } from "./run-event-crawler.js";
import { logger } from "../utils/logger.js";
import { normalizeIcsUrl } from "../utils/ics.js";
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
  // Normalise webcal:// → https:// at the edge so config entries can
  // copy-paste the user-facing "Add to calendar" URL verbatim. We
  // rewrite the URL on both the fetch target AND the parser meta so
  // the sourceUrl built by `parseIcsCalendar` uses the canonical
  // https:// form (browsers can't open webcal://).
  const calendars = (src.calendars ?? []).map((cal) => ({
    ...cal,
    url: normalizeIcsUrl(cal.url),
  }));
  return [
    await runEventCrawler<IcsCalendar>({
      sourceName: src.name,
      pages: calendars.map((cal) => ({ url: cal.url, meta: cal })),
      useProxy: false,
      parsePage: (text, page, sourceName) => {
        if (!page.meta) return [];
        return parseIcsCalendar(text, page.meta, sourceName);
      },
      startContext: { calendars: calendars.length },
    }),
  ];
}
