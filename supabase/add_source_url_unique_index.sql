-- Task 3 of docs/CRAWLER_HANDOVER_CATEGORY_MODEL_DEDUP.md
--
-- The crawler already SELECTs by source_url before INSERT/UPDATE, but that
-- lookup is not atomic: two concurrent crawl runs (or a retried step) can
-- both miss an existing row and then both INSERT, producing the duplicate
-- cards we see on manufacturer hub pages.
--
-- A partial UNIQUE INDEX keyed on source_url (active | paused only) makes
-- the DB refuse the second insert. Soft-archived / expired listings are
-- excluded from the constraint so historical dupes don't block the index
-- build and so re-listing a recently-archived URL still works.
--
-- The index is created CONCURRENTLY so it doesn't lock the listings table
-- during migration. Safe to re-run (IF NOT EXISTS).

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  aircraft_listings_source_url_unique
  ON aircraft_listings (source_url)
  WHERE source_url IS NOT NULL
    AND status IN ('active', 'paused');

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  parts_listings_source_url_unique
  ON parts_listings (source_url)
  WHERE source_url IS NOT NULL
    AND status IN ('active', 'paused');

-- Verification queries (run manually after migration):
--
-- SELECT source_url, COUNT(*)
-- FROM aircraft_listings
-- WHERE status IN ('active', 'paused')
-- GROUP BY source_url
-- HAVING COUNT(*) > 1;
-- -- expects 0 rows after the dedup cleanup + unique-index enforcement.
--
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename IN ('aircraft_listings', 'parts_listings')
--   AND indexname LIKE '%source_url_unique%';
