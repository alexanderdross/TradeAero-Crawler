// ─────────────────────────────────────────────────────────────────────────────
// Source-priority table for cross-source event dedup.
//
// When two ParsedEvent rows share the same canonical_key (see
// event-canonical-key.ts), the row from the higher-priority source wins
// and lower-priority rows are skipped with reason `lower_priority_duplicate`
// (or, if the existing row is the lower-priority one, the upserter
// supersedes it).
//
// Priority order (see EVENT_SOURCES_TIER2_AGGREGATORS.md §4.3):
//
//   100 — primary organisations (Tier-1, planned)
//    90 — organiser-published feeds (vereinsflieger, ICS feeds)
//    60 — community / specialist forums (ulforum)
//    40 — commercial aggregator authoritative for its niche (iata)
//    20 — publisher / magazine reprints (fliegermagazin, pilot-frank)
//    10 — curated tip lists (pilotenausbildung)
//
// Unknown sources default to 50 (between aggregator and forum) so a
// freshly-added source still participates in dedup but doesn't override
// curated organiser feeds until its priority is intentionally pinned.
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY: Record<string, number> = {
  // ── 100: primary organisations (Tier-1) ───────────────────────────────────
  // The org running the event — strongest authority.
  "dulv.de": 100,
  "aero-expo.com": 100,
  "nbaa.org": 100,
  "eurocontrol.int": 100,

  // ── 90: organiser-published feeds ─────────────────────────────────────────
  "vereinsflieger.de": 90,
  "ics-feed": 90,

  // ── 60: community / specialist forums ─────────────────────────────────────
  "ulforum.de": 60,

  // ── 40: commercial aggregator (authoritative within scope) ────────────────
  "iata.org": 40,

  // ── 20: publisher / magazine ──────────────────────────────────────────────
  "fliegermagazin.de": 20,
  "pilot-frank.de": 20,

  // ── 10: curated tip lists ─────────────────────────────────────────────────
  "pilotenausbildung.net": 10,
};

const DEFAULT_PRIORITY = 50;

/** Look up the priority for a `crawler_runs.source_name` / parsed-event
 *  `sourceName`. Falls back to DEFAULT_PRIORITY for unrecognised names. */
export function getSourcePriority(sourceName: string): number {
  return PRIORITY[sourceName] ?? DEFAULT_PRIORITY;
}

/** Decision returned by `compareSourcePriority`. */
export type PriorityComparison =
  | "higher" // new source outranks existing
  | "equal" // same priority — fall through to (external_source, source_url) path
  | "lower"; // existing outranks new — skip insert

/**
 * Compare a new event's source priority against an existing row's
 * source. Used by upsertEvent when both rows share the same
 * canonical_key but come from different `external_source` values.
 */
export function compareSourcePriority(
  newSource: string,
  existingSource: string,
): PriorityComparison {
  const a = getSourcePriority(newSource);
  const b = getSourcePriority(existingSource);
  if (a > b) return "higher";
  if (a < b) return "lower";
  return "equal";
}
