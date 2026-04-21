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
-- NB: this file runs inside Supabase's SQL Editor, which wraps every
-- statement in an implicit transaction. `CREATE INDEX CONCURRENTLY` can't
-- run inside a transaction block (PG error 25001: "CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block"), so we use plain
-- `CREATE UNIQUE INDEX` which holds an ACCESS EXCLUSIVE lock on the table
-- for the duration of the index build. For current table sizes that's
-- sub-second and acceptable. If the tables ever grow to millions of rows,
-- run the SQL via `psql` / `supabase db execute` outside a transaction and
-- re-introduce the CONCURRENTLY keyword.
--
-- Safe to re-run — `IF NOT EXISTS` guards both indexes.

CREATE UNIQUE INDEX IF NOT EXISTS aircraft_listings_source_url_unique
  ON aircraft_listings (source_url)
  WHERE source_url IS NOT NULL
    AND status IN ('active', 'paused');

CREATE UNIQUE INDEX IF NOT EXISTS parts_listings_source_url_unique
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
