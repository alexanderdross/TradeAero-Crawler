import * as cheerio from "cheerio";
import { fetchPage } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// seed-ics-calendars
//
// Discovery helper for the Tier-1 events-source plan
// (`docs/crawlers/EVENT_SOURCES_TIER1.md`). Visits each canonical
// events / calendar HTML page, parses it for any iCalendar feed URL
// (.ics, .ical, webcal://, or a `<link rel="alternate" type="text/calendar">`
// hint), and prints ready-to-paste IcsCalendar config entries to stdout.
//
// Operator workflow:
//
//   npm run seed:ics-calendars                 # run against the default list
//   npm run seed:ics-calendars -- --json       # machine-readable JSON output
//   npm run seed:ics-calendars -- --proxy      # route fetches through Bright
//                                              # Data (set BRIGHT_DATA_PROXY_URL)
//   npm run seed:ics-calendars -- --url=https://… [--url=…]
//                                              # custom one-off URLs
//
// The script does NOT mutate config.ts — it only prints. The operator
// reviews each entry, fills in `country`, `defaultCategory`, and
// `sourceLocale` per the vetting checklist in ICS_FEED_CONCEPT.md, and
// commits the additions to `config.sources.ics.calendars[]`.
//
// When direct fetches hit anti-bot or geo blocks (FAI / NBAA / etc.
// frequently 403 from datacentre IPs), pass `--proxy` so fetchPage
// routes through the same Bright Data residential proxy used by the
// aircraft24 / aeromarkt crawlers. Same env var
// (`BRIGHT_DATA_PROXY_URL`) — no extra config.
//
// Why a script and not direct config wiring? See
// EVENT_SOURCES_TIER1.md §3 — every feed needs human ToS / robots.txt
// review before it goes live. The script's job is to surface the
// candidate URLs, not commit to crawling them.
// ─────────────────────────────────────────────────────────────────────────────

interface SeedTarget {
  /** Org name — surfaced in the printed entry's `name` field. */
  name: string;
  /** Canonical events / calendar HTML page to scan. */
  url: string;
  /** ISO 3166-1 alpha-2 hint for the printed `country` field. */
  country: string;
  /** Source locale guess. Operator can override after vetting. */
  sourceLocale: string;
  /** Default `event_categories.code` guess for events without a CATEGORIES line. */
  defaultCategory: string;
  /** Optional friendly name for the `organiserName` fallback. */
  organiserName?: string;
}

/**
 * Default list — mirrors the eleven Tier-1 sources from
 * `EVENT_SOURCES_TIER1.md`. Each entry's `url` is the canonical
 * organisation events page, NOT a guessed `.ics` URL — the script's
 * job is to discover the feed (if any) by scanning the page.
 */
const DEFAULT_TARGETS: SeedTarget[] = [
  {
    name: "EAA chapter directory",
    url: "https://www.eaa.org/eaa/eaa-chapters",
    country: "US",
    sourceLocale: "en",
    defaultCategory: "meetup",
    organiserName: "EAA Chapters",
  },
  {
    name: "AOPA events",
    url: "https://www.aopa.org/community/events",
    country: "US",
    sourceLocale: "en",
    defaultCategory: "meetup",
    organiserName: "AOPA",
  },
  {
    name: "FAI calendar",
    url: "https://www.fai.org/calendar",
    country: "CH",
    sourceLocale: "en",
    defaultCategory: "competition",
    organiserName: "FAI",
  },
  {
    name: "FAI / CIVA aerobatics",
    url: "https://www.fai.org/commission/civa",
    country: "CH",
    sourceLocale: "en",
    defaultCategory: "competition",
    organiserName: "FAI CIVA",
  },
  {
    name: "NBAA events",
    url: "https://nbaa.org/events/",
    country: "US",
    sourceLocale: "en",
    defaultCategory: "trade-fair",
    organiserName: "NBAA",
  },
  {
    name: "EBACE",
    url: "https://www.ebace.aero/",
    country: "CH",
    sourceLocale: "en",
    defaultCategory: "trade-fair",
    organiserName: "EBACE",
  },
  {
    name: "AERO Friedrichshafen",
    url: "https://www.aero-expo.com/",
    country: "DE",
    sourceLocale: "de",
    defaultCategory: "trade-fair",
    organiserName: "AERO Friedrichshafen",
  },
  {
    name: "Eurocontrol events",
    url: "https://www.eurocontrol.int/events",
    country: "BE",
    sourceLocale: "en",
    defaultCategory: "seminar",
    organiserName: "Eurocontrol",
  },
  {
    name: "DAeC (parent of BBR)",
    url: "https://www.daec.de/sportarten/segelflug/",
    country: "DE",
    sourceLocale: "de",
    defaultCategory: "competition",
    organiserName: "DAeC / BBR Segelflug",
  },
  {
    name: "DULV",
    url: "https://www.dulv.de/",
    country: "DE",
    sourceLocale: "de",
    defaultCategory: "meetup",
    organiserName: "DULV",
  },
  {
    name: "FFA (Fédération Française Aéronautique)",
    url: "https://www.ff-aero.fr/",
    country: "FR",
    sourceLocale: "fr",
    defaultCategory: "meetup",
    organiserName: "FFA",
  },
  {
    name: "GASCo",
    url: "https://www.gasco.org.uk/",
    country: "GB",
    sourceLocale: "en",
    defaultCategory: "seminar",
    organiserName: "GASCo",
  },
];

interface DiscoveredFeed {
  /** Absolute feed URL (`.ics`, `.ical`, `webcal://`, or
   *  `<link rel="alternate" type="text/calendar">`). */
  feedUrl: string;
  /** What kind of link surfaced the feed — useful for triage when more
   *  than one candidate is found on a single page. */
  via: "anchor-href" | "link-alternate" | "webcal";
}

/** Scan an HTML payload for ICS feed candidates. Returns deduplicated
 *  absolute URLs. Empty array when nothing found. */
export function extractIcsFeeds(
  html: string,
  pageUrl: string,
): DiscoveredFeed[] {
  const $ = cheerio.load(html);
  const out = new Map<string, DiscoveredFeed>();

  const absolutize = (href: string): string | null => {
    try {
      // Normalise webcal:// → https:// for a stable dedup key but keep
      // the webcal:// in the printed feed when that's what the page
      // exposed (some clients prefer the protocol hint).
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  };

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href) return;
    const lower = href.toLowerCase();
    if (lower.startsWith("webcal://")) {
      const abs = absolutize(href);
      if (abs) out.set(abs, { feedUrl: abs, via: "webcal" });
      return;
    }
    if (
      lower.endsWith(".ics") ||
      lower.endsWith(".ical") ||
      lower.includes(".ics?") ||
      lower.includes(".ical?")
    ) {
      const abs = absolutize(href);
      if (abs) out.set(abs, { feedUrl: abs, via: "anchor-href" });
    }
  });

  $("link[rel='alternate'][type='text/calendar']").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href) return;
    const abs = absolutize(href);
    if (abs && !out.has(abs))
      out.set(abs, { feedUrl: abs, via: "link-alternate" });
  });

  return [...out.values()];
}

/** Format a single hit as a TypeScript snippet for direct paste into
 *  `config.sources.ics.calendars[]`. */
function formatEntry(target: SeedTarget, feed: DiscoveredFeed): string {
  const lines: string[] = [
    "{",
    `  name: ${JSON.stringify(target.name)},`,
    `  url: ${JSON.stringify(feed.feedUrl)},`,
    `  country: ${JSON.stringify(target.country)},`,
    `  defaultCategory: ${JSON.stringify(target.defaultCategory)},`,
    `  sourceLocale: ${JSON.stringify(target.sourceLocale)},`,
  ];
  if (target.organiserName) {
    lines.push(`  organiserName: ${JSON.stringify(target.organiserName)},`);
  }
  lines.push(`  // discovered via: ${feed.via}`);
  lines.push("},");
  return lines.join("\n");
}

interface RunReport {
  target: SeedTarget;
  feeds: DiscoveredFeed[];
  error?: string;
}

async function run(
  targets: SeedTarget[],
  options: { proxy: boolean },
): Promise<RunReport[]> {
  const reports: RunReport[] = [];
  for (const t of targets) {
    try {
      logger.info("Scanning", { name: t.name, url: t.url, proxy: options.proxy });
      const html = await fetchPage(t.url, { proxy: options.proxy });
      const feeds = extractIcsFeeds(html, t.url);
      reports.push({ target: t, feeds });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reports.push({ target: t, feeds: [], error: msg });
      logger.warn("Scan failed", { name: t.name, url: t.url, error: msg });
    }
  }
  return reports;
}

function parseArgs(): {
  customUrls: string[];
  json: boolean;
  proxy: boolean;
} {
  const customUrls: string[] = [];
  let json = false;
  let proxy = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--json") json = true;
    else if (arg === "--proxy") proxy = true;
    else if (arg.startsWith("--url=")) customUrls.push(arg.slice("--url=".length));
  }
  return { customUrls, json, proxy };
}

async function main(): Promise<void> {
  const { customUrls, json, proxy } = parseArgs();

  const targets: SeedTarget[] =
    customUrls.length > 0
      ? customUrls.map((u) => ({
          name: new URL(u).hostname,
          url: u,
          country: "??",
          sourceLocale: "en",
          defaultCategory: "general",
        }))
      : DEFAULT_TARGETS;

  if (proxy && !process.env.BRIGHT_DATA_PROXY_URL) {
    logger.warn(
      "--proxy requested but BRIGHT_DATA_PROXY_URL is not set — falling back to direct fetch",
    );
  }

  const reports = await run(targets, { proxy });

  if (json) {
    process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
    return;
  }

  console.log("\n=== ICS feed discovery ===\n");
  let withFeeds = 0;
  let withoutFeeds = 0;
  for (const r of reports) {
    if (r.feeds.length > 0) {
      withFeeds++;
      console.log(`# ${r.target.name} (${r.target.url})`);
      for (const f of r.feeds) {
        console.log(formatEntry(r.target, f));
      }
      console.log("");
    } else {
      withoutFeeds++;
    }
  }

  if (withoutFeeds > 0) {
    console.log("=== No ICS feed found — needs bespoke HTML crawler ===\n");
    for (const r of reports) {
      if (r.feeds.length === 0) {
        const tag = r.error ? ` (error: ${r.error})` : "";
        console.log(`- ${r.target.name}: ${r.target.url}${tag}`);
      }
    }
    console.log("");
  }

  console.log(
    `Scanned ${reports.length} target(s) — ${withFeeds} with ICS, ${withoutFeeds} without.\n`,
  );
}

// Only run when invoked as a CLI (not when imported by tests).
const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("seed-ics-calendars.ts") ||
  process.argv[1]?.endsWith("seed-ics-calendars.js");

if (isCli) {
  main().catch((err) => {
    logger.error("Fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
