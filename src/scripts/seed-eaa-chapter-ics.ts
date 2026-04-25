import * as cheerio from "cheerio";
import { fetchPage } from "../utils/fetch.js";
import { extractIcsFeeds } from "./seed-ics-calendars.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// EAA chapter ICS bulk-discovery script.
//
// The Experimental Aircraft Association runs ~900 local chapters, each
// with its own events page. Most chapters that publish events expose
// them through the EAA chapter management platform which embeds an
// `.ics` URL on the chapter's "Events" tab. Manually finding those
// URLs is the bottleneck; the seed script automates it.
//
// Workflow (operator):
//
//   1. Run this script with --proxy (Bright Data) so the EAA chapter
//      directory + per-chapter pages don't 403 from datacentre IPs:
//
//         npm run seed:eaa-chapters -- --proxy
//
//   2. The script scrapes the chapter directory, extracts every
//      chapter's "Events" / "Calendar" page URL, fetches each one,
//      and prints any `.ics` / `.ical` / `webcal://` link it finds.
//
//   3. Output is a list of ready-to-paste IcsCalendar config entries
//      (see `seed-ics-calendars.ts` for the format). Operator
//      reviews each entry and pastes vetted ones into
//      `config.sources.ics.calendars[]`.
//
// This script does NOT mutate config.ts and does NOT publish anything.
// Discovery only — same operational stance as `seed-ics-calendars.ts`.
//
// **Status: skeleton.** The chapter-directory URL + the chapter-page
// HTML structure need verification once a Bright Data proxy is
// available. The pure logic (per-chapter ICS extraction) reuses the
// already-tested `extractIcsFeeds` helper so the only real recon is
// the directory selector below.
// ─────────────────────────────────────────────────────────────────────────────

const EAA_CHAPTER_DIRECTORY_URL = "https://www.eaa.org/eaa/eaa-chapters";

interface ChapterEntry {
  /** Display name, e.g. "EAA Chapter 252 — Pittsburgh, PA" */
  name: string;
  /** Direct URL to the chapter's homepage or events page. */
  url: string;
  /** ISO 3166-1 alpha-2 country code. EAA chapters are mostly US. */
  country: string;
}

/**
 * Scrape the chapter directory page and return one entry per chapter.
 *
 * The EAA directory is a paginated server-rendered HTML list. Each
 * entry links to the chapter's profile page; from there a "Visit
 * Chapter Site" button or "Events" tab carries the ICS feed.
 *
 * Selector below is the OPERATOR'S TODO: capture the live HTML once
 * with `curl --proxy $BRIGHT_DATA_PROXY_URL ...` and tune the cheerio
 * selector against it before enabling.
 */
async function scrapeChapterDirectory(
  useProxy: boolean,
): Promise<ChapterEntry[]> {
  const html = await fetchPage(EAA_CHAPTER_DIRECTORY_URL, { proxy: useProxy });
  const $ = cheerio.load(html);
  const entries: ChapterEntry[] = [];

  // Placeholder: each entry container — verify against the live DOM.
  // The expected shape:
  //   <a class="chapter-card-link" href="/chapter/123">
  //     <span class="chapter-name">EAA Chapter 123 — City, ST</span>
  //   </a>
  $("a.chapter-card-link, a.chapter-link").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const name = ($(el).find(".chapter-name, h3").first().text() || "")
      .trim();
    if (!href || !name) return;
    try {
      const url = new URL(href, EAA_CHAPTER_DIRECTORY_URL).toString();
      entries.push({ name, url, country: "US" });
    } catch {
      // Ignore unparseable hrefs.
    }
  });

  if (entries.length === 0) {
    logger.warn(
      "scrapeChapterDirectory found 0 entries — verify the chapter-card selector against live HTML before relying on the output",
      { url: EAA_CHAPTER_DIRECTORY_URL },
    );
  }
  return entries;
}

/**
 * For each chapter entry, fetch its homepage and extract any
 * iCalendar feed URL. Per-chapter failures are logged and skipped;
 * the script never aborts on a single bad chapter.
 */
async function discoverChapterFeeds(
  chapters: ChapterEntry[],
  useProxy: boolean,
): Promise<
  Array<{
    chapter: ChapterEntry;
    feedUrl: string;
    discoveredVia: "anchor-href" | "link-alternate" | "webcal";
  }>
> {
  const found: Array<{
    chapter: ChapterEntry;
    feedUrl: string;
    discoveredVia: "anchor-href" | "link-alternate" | "webcal";
  }> = [];
  for (const chapter of chapters) {
    try {
      const html = await fetchPage(chapter.url, { proxy: useProxy });
      const feeds = extractIcsFeeds(html, chapter.url);
      for (const feed of feeds) {
        found.push({ chapter, feedUrl: feed.feedUrl, discoveredVia: feed.via });
      }
    } catch (err) {
      logger.warn("EAA chapter scan failed", {
        chapter: chapter.name,
        url: chapter.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return found;
}

function formatEntry(opts: {
  chapter: ChapterEntry;
  feedUrl: string;
  discoveredVia: string;
}): string {
  return [
    "{",
    `  name: ${JSON.stringify(opts.chapter.name)},`,
    `  url: ${JSON.stringify(opts.feedUrl)},`,
    `  country: ${JSON.stringify(opts.chapter.country)},`,
    `  defaultCategory: "meetup",`,
    `  sourceLocale: "en",`,
    `  organiserName: ${JSON.stringify(opts.chapter.name)},`,
    `  // discovered via: ${opts.discoveredVia}`,
    "},",
  ].join("\n");
}

async function main(): Promise<void> {
  const useProxy = process.argv.includes("--proxy");
  if (useProxy && !process.env.BRIGHT_DATA_PROXY_URL) {
    logger.warn(
      "--proxy requested but BRIGHT_DATA_PROXY_URL is not set — falling back to direct fetch (likely 403s)",
    );
  }

  logger.info("EAA chapter discovery starting", {
    directory: EAA_CHAPTER_DIRECTORY_URL,
    proxy: useProxy,
  });

  const chapters = await scrapeChapterDirectory(useProxy);
  logger.info(`Found ${chapters.length} chapter entries`);

  const feeds = await discoverChapterFeeds(chapters, useProxy);
  logger.info(`Discovered ${feeds.length} ICS feeds across ${chapters.length} chapters`);

  console.log("\n=== EAA chapter ICS discovery ===\n");
  for (const f of feeds) {
    console.log(formatEntry(f));
    console.log("");
  }
  console.log(
    `Scanned ${chapters.length} chapters — ${feeds.length} ICS feeds found.\n`,
  );
}

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("seed-eaa-chapter-ics.ts") ||
  process.argv[1]?.endsWith("seed-eaa-chapter-ics.js");

if (isCli) {
  main().catch((err) => {
    logger.error("Fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
