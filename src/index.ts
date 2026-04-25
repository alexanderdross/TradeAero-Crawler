import { validateConfig } from "./config.js";
import { crawlHelmut } from "./crawlers/helmut-crawler.js";
import { crawlAircraft24 } from "./crawlers/aircraft24-crawler.js";
import { crawlAeromarkt } from "./crawlers/aeromarkt-crawler.js";
import { crawlVereinsflieger } from "./crawlers/vereinsflieger-crawler.js";
import { crawlIcs } from "./crawlers/ics-crawler.js";
import { crawlPilotenausbildung } from "./crawlers/pilotenausbildung-crawler.js";
import { crawlFliegermagazin } from "./crawlers/fliegermagazin-crawler.js";
import { crawlUlforum } from "./crawlers/ulforum-crawler.js";
import { crawlIata } from "./crawlers/iata-crawler.js";
import { crawlPilotFrank } from "./crawlers/pilot-frank-crawler.js";
import { crawlDulv } from "./crawlers/dulv-crawler.js";
import { crawlAeroFriedrichshafen } from "./crawlers/aero-friedrichshafen-crawler.js";
import { crawlNbaa } from "./crawlers/nbaa-crawler.js";
import { crawlEurocontrol } from "./crawlers/eurocontrol-crawler.js";
import { logger } from "./utils/logger.js";

type Source =
  | "helmut"
  | "aircraft24"
  | "aeromarkt"
  | "vereinsflieger"
  | "ics"
  | "pilotenausbildung"
  | "fliegermagazin"
  | "ulforum"
  | "iata"
  | "pilot-frank"
  | "dulv"
  | "aero-friedrichshafen"
  | "nbaa"
  | "eurocontrol";
type Target = "aircraft" | "parts" | "events" | "all";

async function main(): Promise<void> {
  // Pre-prod kill switch. On the `production` GitHub Environment the
  // variable is left unset, so the workflow exits cleanly without hitting
  // the external sources or touching tradeaero-prod. dev/QA (main branch)
  // sets it to "true" so the daily crawls keep populating tradeaero-dev.
  if (process.env.CRAWLER_ENABLED !== "true") {
    logger.info("CRAWLER_ENABLED is not 'true'; exiting without crawling.", {
      branch: process.env.GITHUB_REF_NAME ?? "(unknown)",
    });
    return;
  }

  validateConfig();

  const source = parseSource();
  const target = parseTarget();
  logger.info(`TradeAero Crawler starting`, { source, target });

  const results = [];

  switch (source) {
    case "helmut":
      results.push(...(await crawlHelmut(target === "events" ? "all" : target)));
      break;
    case "aircraft24":
      results.push(...(await crawlAircraft24(target === "events" ? "all" : target)));
      break;
    case "aeromarkt":
      results.push(...(await crawlAeromarkt(target === "events" ? "all" : target)));
      break;
    case "vereinsflieger":
      results.push(...(await crawlVereinsflieger(target)));
      break;
    case "ics":
      results.push(...(await crawlIcs(target)));
      break;
    case "pilotenausbildung":
      results.push(...(await crawlPilotenausbildung(target)));
      break;
    case "fliegermagazin":
      results.push(...(await crawlFliegermagazin(target)));
      break;
    case "ulforum":
      results.push(...(await crawlUlforum(target)));
      break;
    case "iata":
      results.push(...(await crawlIata(target)));
      break;
    case "pilot-frank":
      results.push(...(await crawlPilotFrank(target)));
      break;
    case "dulv":
      results.push(...(await crawlDulv(target)));
      break;
    case "aero-friedrichshafen":
      results.push(...(await crawlAeroFriedrichshafen(target)));
      break;
    case "nbaa":
      results.push(...(await crawlNbaa(target)));
      break;
    case "eurocontrol":
      results.push(...(await crawlEurocontrol(target)));
      break;
  }

  // Print summary
  console.log("\n=== Crawl Summary ===");
  for (const r of results) {
    console.log(`\n[${r.target.toUpperCase()}] ${r.source}`);
    console.log(`  Pages processed: ${r.pagesProcessed}`);
    console.log(`  Listings found:  ${r.listingsFound}`);
    console.log(`  Inserted:        ${r.listingsInserted}`);
    console.log(`  Updated:         ${r.listingsUpdated}`);
    console.log(`  Skipped:         ${r.listingsSkipped}`);
    console.log(`  Errors:          ${r.errors.length}`);
    if (r.errors.length > 0) {
      for (const err of r.errors) {
        console.log(`    - ${err}`);
      }
    }
    console.log(`  Duration:        ${timeDiff(r.startedAt, r.completedAt)}`);
  }

  const hasErrors = results.some((r) => r.errors.length > 0);
  if (hasErrors) {
    logger.warn("Crawl completed with errors");
    process.exit(1);
  }

  logger.info("Crawl completed successfully");
}

function parseSource(): Source {
  const validSources: Source[] = [
    "helmut",
    "aircraft24",
    "aeromarkt",
    "vereinsflieger",
    "ics",
    "pilotenausbildung",
    "fliegermagazin",
    "ulforum",
    "iata",
    "pilot-frank",
    "dulv",
    "aero-friedrichshafen",
    "nbaa",
    "eurocontrol",
  ];
  const arg = process.argv.find((a) => a.startsWith("--source"));
  if (!arg) return "helmut";

  const value = arg.includes("=") ? arg.split("=")[1] : process.argv[process.argv.indexOf(arg) + 1];

  if (validSources.includes(value as Source)) {
    return value as Source;
  }

  logger.error(`Invalid source "${value}". Valid sources: ${validSources.join(", ")}`);
  process.exit(1);
  return "helmut" as never;
}

function parseTarget(): Target {
  const validTargets: Target[] = ["all", "aircraft", "parts", "events"];
  const arg = process.argv.find((a) => a.startsWith("--target"));
  if (!arg) return "all";

  const value = arg.includes("=") ? arg.split("=")[1] : process.argv[process.argv.indexOf(arg) + 1];

  if (validTargets.includes(value as Target)) {
    return value as Target;
  }

  logger.error(`Invalid target "${value}". Valid targets: ${validTargets.join(", ")}`);
  process.exit(1);
  return "all" as never;
}

function timeDiff(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

main().catch((err) => {
  logger.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
