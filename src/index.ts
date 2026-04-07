import { validateConfig } from "./config.js";
import { crawlHelmut } from "./crawlers/helmut-crawler.js";
import { crawlAircraft24 } from "./crawlers/aircraft24-crawler.js";
import { crawlAeromarkt } from "./crawlers/aeromarkt-crawler.js";
import { logger } from "./utils/logger.js";

type Source = "helmut" | "aircraft24" | "aeromarkt";
type Target = "aircraft" | "parts" | "all";

async function main(): Promise<void> {
  validateConfig();

  const source = parseSource();
  const target = parseTarget();
  logger.info(`TradeAero Crawler starting`, { source, target });

  const results = [];

  switch (source) {
    case "helmut":
      results.push(...(await crawlHelmut(target)));
      break;
    case "aircraft24":
      results.push(...(await crawlAircraft24(target)));
      break;
    case "aeromarkt":
      results.push(...(await crawlAeromarkt(target)));
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
  const validSources: Source[] = ["helmut", "aircraft24", "aeromarkt"];
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
  const validTargets: Target[] = ["all", "aircraft", "parts"];
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
