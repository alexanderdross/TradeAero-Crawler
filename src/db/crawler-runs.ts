import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";

export interface CrawlRunStats {
  pagesProcessed: number;
  listingsFound: number;
  listingsInserted: number;
  listingsUpdated: number;
  listingsSkipped: number;
  errors: number;
  imagesUploaded: number;
  translationsCompleted: number;
}

export interface CrawlRun {
  id: string;
  runId: string;
  sourceName: string;
  target: string;
}

/**
 * Start a new crawler run record in the database.
 */
export async function startCrawlRun(
  sourceName: string,
  target: string
): Promise<string | null> {
  const runId = `${target}-${Date.now()}`;

  const { data, error } = await supabase
    .from("crawler_runs")
    .insert({
      run_id: runId,
      source_name: sourceName,
      target,
      status: "running",
      started_at: new Date().toISOString(),
      metadata: {
        node_version: process.version,
        github_sha: process.env.GITHUB_SHA ?? null,
        github_run_id: process.env.GITHUB_RUN_ID ?? null,
      },
    })
    .select("id")
    .single();

  if (error) {
    logger.warn("Failed to create crawl run record", { error: error.message });
    return null;
  }

  return data.id;
}

/**
 * Complete a crawler run with final stats.
 */
export async function completeCrawlRun(
  id: string,
  stats: CrawlRunStats,
  startTime: number,
  warnings: string[] = []
): Promise<void> {
  const { error } = await supabase
    .from("crawler_runs")
    .update({
      status: "completed",
      pages_processed: stats.pagesProcessed,
      listings_found: stats.listingsFound,
      listings_inserted: stats.listingsInserted,
      listings_updated: stats.listingsUpdated,
      listings_skipped: stats.listingsSkipped,
      errors: stats.errors,
      images_uploaded: stats.imagesUploaded,
      translations_completed: stats.translationsCompleted,
      duration_ms: Date.now() - startTime,
      warnings: warnings.slice(0, 100), // Cap at 100 warnings
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    logger.warn("Failed to update crawl run record", { error: error.message });
  }
}

/**
 * Mark a crawler run as failed.
 */
export async function failCrawlRun(
  id: string,
  errorMessage: string,
  startTime: number
): Promise<void> {
  const { error } = await supabase
    .from("crawler_runs")
    .update({
      status: "failed",
      error_message: errorMessage,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    logger.warn("Failed to mark crawl run as failed", { error: error.message });
  }
}
