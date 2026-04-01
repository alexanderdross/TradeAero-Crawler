import { validateConfig } from "./config.js";
import { crawlAircraft } from "./crawlers/aircraft-crawler.js";
import { crawlParts } from "./crawlers/parts-crawler.js";
import { logger } from "./utils/logger.js";

type Target = "aircraft" | "parts" | "all";

async function main(): Promise<void> {
  validateConfig();

  const target = parseTarget();
  logger.info(`TradeAero Crawler starting`, { target });

  const results = [];

  if (target === "aircraft" || target === "all") {
    results.push(await crawlAircraft());
  }

  if (target === "parts" || target === "all") {
    results.push(await crawlParts());
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

  // Exit with error code if any crawl had errors
  const hasErrors = results.some((r) => r.errors.length > 0);
  if (hasErrors) {
    logger.warn("Crawl completed with errors");
    process.exit(1);
  }

  logger.info("Crawl completed successfully");
}

function parseTarget(): Target {
  const arg = process.argv.find((a) => a.startsWith("--target"));
  if (!arg) return "all";

  const value = arg.includes("=") ? arg.split("=")[1] : process.argv[process.argv.indexOf(arg) + 1];

  if (value === "aircraft" || value === "parts" || value === "all") {
    return value;
  }

  logger.warn(`Unknown target "${value}", defaulting to "all"`);
  return "all";
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
