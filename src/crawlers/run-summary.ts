import type { UpsertSkipReason } from "../db/events-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for the runEventCrawler aggregation/summary path.
//
// Lives in its own module so unit tests can import without dragging in
// the Supabase client (run-event-crawler.ts imports db/events.ts which
// initializes the service-role client at module load — fine in
// production, breaks tests that have no SUPABASE_URL set).
// ─────────────────────────────────────────────────────────────────────────────

/** Skip reasons that signal expected pipeline behaviour rather than a
 *  data-quality issue worth surfacing in a warning. `unchanged` happens
 *  on every re-crawl of an already-seen row; `concurrent_insert`
 *  happens during overlapping runs. Everything else (validation drops)
 *  is interesting. */
export const NORMAL_SKIP_REASONS: ReadonlySet<UpsertSkipReason> =
  new Set<UpsertSkipReason>(["unchanged", "concurrent_insert"]);

/**
 * Build a one-line warning summarizing validation-class drops for the
 * run's `warnings[]` column. Excludes normal skip reasons. Returns
 * null when there's nothing worth flagging.
 *
 * Output shape: `validation drops: <total> (<reason1>: <n1>, <reason2>: <n2>, …)`
 *
 * Reasons are sorted by descending count so the most common cause
 * appears first, ties broken alphabetically (deterministic for tests +
 * dashboard parsing).
 */
export function buildValidationDropSummary(
  reasons: Record<string, number>,
): string | null {
  const interesting = Object.entries(reasons)
    .filter(([k]) => !NORMAL_SKIP_REASONS.has(k as UpsertSkipReason))
    .sort(([ka, a], [kb, b]) => (b - a) || ka.localeCompare(kb));
  if (interesting.length === 0) return null;
  const total = interesting.reduce((sum, [, n]) => sum + n, 0);
  const detail = interesting.map(([k, n]) => `${k}: ${n}`).join(", ");
  return `validation drops: ${total} (${detail})`;
}
