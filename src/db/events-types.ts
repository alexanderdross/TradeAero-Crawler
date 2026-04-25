import type { EventValidationReason } from "./event-validation.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight type-only re-export from events.ts.
//
// `db/events.ts` imports the Supabase client at module load, which
// works fine in production but breaks unit tests that need to use
// these types without booting the DB layer. Putting the types in their
// own file keeps the import graph clean.
// ─────────────────────────────────────────────────────────────────────────────

/** Reason an upsertEvent call ended in `kind: "skipped"`. Anything in
 *  `EventValidationReason` is a parser-side sanity drop; the other two
 *  are decided in the DB step. The runEventCrawler aggregates these
 *  per-run so the admin dashboard can chart "why are events being
 *  dropped". */
export type UpsertSkipReason =
  | EventValidationReason
  | "unchanged"
  | "concurrent_insert";

export type UpsertOutcome =
  | { kind: "inserted" }
  | { kind: "updated" }
  | { kind: "skipped"; reason: UpsertSkipReason };
