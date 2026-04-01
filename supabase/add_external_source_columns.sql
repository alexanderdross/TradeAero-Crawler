-- Schema extension for external listing source attribution (Epic 3)
-- Run this migration on the TradeAero Supabase database BEFORE running the crawler.
--
-- Adds 3 columns to aircraft_listings and parts_listings:
--   source_name  – The source website (e.g., "helmuts-ul-seiten.de")
--   source_url   – Stable deduplication key (pageUrl#index@date)
--   is_external  – Boolean flag to distinguish scraped vs user-created listings
--
-- These columns are NULLABLE so existing user-created listings are unaffected.
-- A unique index on source_url enables idempotent upserts (Epic 4.1).

-- ============================================================
-- aircraft_listings
-- ============================================================
ALTER TABLE public.aircraft_listings
  ADD COLUMN IF NOT EXISTS source_name text,
  ADD COLUMN IF NOT EXISTS source_url  text,
  ADD COLUMN IF NOT EXISTS is_external boolean DEFAULT false;

-- Unique index for deduplication: only one external listing per source URL
CREATE UNIQUE INDEX IF NOT EXISTS idx_aircraft_listings_source_url
  ON public.aircraft_listings (source_url)
  WHERE source_url IS NOT NULL;

-- Partial index for filtering external listings
CREATE INDEX IF NOT EXISTS idx_aircraft_listings_is_external
  ON public.aircraft_listings (is_external)
  WHERE is_external = true;

-- ============================================================
-- parts_listings
-- ============================================================
ALTER TABLE public.parts_listings
  ADD COLUMN IF NOT EXISTS source_name text,
  ADD COLUMN IF NOT EXISTS source_url  text,
  ADD COLUMN IF NOT EXISTS is_external boolean DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_listings_source_url
  ON public.parts_listings (source_url)
  WHERE source_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parts_listings_is_external
  ON public.parts_listings (is_external)
  WHERE is_external = true;

-- ============================================================
-- RLS: External listings are publicly readable (same as native active listings).
-- No new RLS policies needed – existing "public can read active listings"
-- policies already cover these rows since they check status = 'active'.
--
-- External listings are NOT editable by regular users because:
-- 1. user_id points to the system crawler account
-- 2. Existing "owner can update own listings" RLS checks auth.uid() = user_id
-- 3. No real user will match the crawler's system user_id
-- ============================================================

COMMENT ON COLUMN public.aircraft_listings.source_name IS 'External source website name (e.g., helmuts-ul-seiten.de). NULL for user-created listings.';
COMMENT ON COLUMN public.aircraft_listings.source_url IS 'Stable deduplication key for external listings. Format: pageUrl#index@date. NULL for user-created.';
COMMENT ON COLUMN public.aircraft_listings.is_external IS 'True if listing was scraped from an external source. False/NULL for user-created.';
COMMENT ON COLUMN public.parts_listings.source_name IS 'External source website name. NULL for user-created listings.';
COMMENT ON COLUMN public.parts_listings.source_url IS 'Stable deduplication key for external listings. NULL for user-created.';
COMMENT ON COLUMN public.parts_listings.is_external IS 'True if listing was scraped from an external source. False/NULL for user-created.';
