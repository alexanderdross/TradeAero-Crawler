# TradeAero Crawler - Codebase Reference

## Overview

Standalone Node.js/TypeScript crawler that scrapes aircraft and parts listings from external aviation marketplaces (currently Helmut's UL Seiten) and ingests them into the TradeAero Supabase database at https://refactor.trade.aero.

The crawler downloads images to Supabase Storage, translates all content into 14 languages using Claude Haiku 4.5, generates localized URL slugs, and logs run history for admin dashboard monitoring.

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript 5
- **HTML Parsing**: Cheerio (static HTML, no headless browser needed)
- **Database**: Supabase PostgreSQL via `@supabase/supabase-js` (service role key bypasses RLS)
- **Translation**: Anthropic Claude Haiku 4.5 via `@anthropic-ai/sdk`
- **Image Storage**: Supabase Storage (`aircraft-images` and `parts-images` buckets)
- **Scheduling**: GitHub Actions cron (daily 06:00 UTC) + manual dispatch
- **Testing**: Vitest

## Project Structure

```
src/
  index.ts                    # CLI entry point (--target aircraft|parts|all)
  config.ts                   # Environment config, source URLs, defaults
  types.ts                    # Shared TypeScript interfaces (ParsedAircraftListing, ParsedPartsListing, CrawlResult)
  crawlers/
    aircraft-crawler.ts       # Orchestrates aircraft crawl: fetch → parse → translate → upload images → upsert → log run
    parts-crawler.ts          # Orchestrates parts crawl with same pipeline
  parsers/
    aircraft.ts               # Parses unstructured HTML → ParsedAircraftListing[] (regex-based extraction)
    parts.ts                  # Parses unstructured HTML → ParsedPartsListing[] (category detection)
  db/
    client.ts                 # Supabase client (service role, no session persistence)
    aircraft.ts               # Validate → translate → upload images → upsert aircraft_listings
    parts.ts                  # Validate → translate → upload images → upsert parts_listings
    system-user.ts            # Lookup/cache system crawler user_id (crawler@trade.aero)
    crawler-runs.ts           # Log crawl run start/complete/fail to crawler_runs table
  utils/
    fetch.ts                  # HTTP fetch with retry (3 attempts), exponential backoff, polite delay
    html.ts                   # Email deobfuscation, price parsing, German date parsing, text cleaning
    images.ts                 # Download external images → upload to Supabase Storage (max 3 concurrent)
    translate.ts              # Claude Haiku 4.5 translation to 14 locales
    slug.ts                   # Localized slug generation (Cyrillic/Greek/Turkish transliteration)
    logger.ts                 # Structured logging with timestamp, level, context
supabase/
  add_external_source_columns.sql   # Schema migration: source_name, source_url, is_external
  add_crawler_runs_table.sql        # Schema migration: crawler_runs monitoring table
.github/workflows/
  crawl.yml                   # Daily cron (06:00 UTC) + manual workflow_dispatch
```

## Commands

```bash
npm run dev              # Run crawler (all targets) via tsx
npm run crawl:aircraft   # Crawl aircraft only
npm run crawl:parts      # Crawl parts only
npm run crawl:all        # Crawl everything
npm run build            # Compile TypeScript to dist/
npm run start            # Run compiled JS (dist/index.js)
npm test                 # Run vitest unit tests
npm run test:watch       # Run vitest in watch mode
```

## Environment Variables

```
SUPABASE_URL               # Required. Supabase project URL (https://xxx.supabase.co)
SUPABASE_SERVICE_ROLE_KEY  # Required. Service role JWT key (bypasses RLS)
ANTHROPIC_API_KEY          # Required for translation. Claude Haiku 4.5 API key (sk-ant-...)
CRAWLER_SYSTEM_USER_ID     # Optional. UUID of crawler system profile. Looked up by email if not set.
CRAWLER_USER_AGENT         # Optional. HTTP User-Agent header (default: TradeAero-Crawler/1.0)
CRAWL_DELAY_MS             # Optional. Delay between page fetches in ms (default: 2000)
```

## GitHub Actions Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase Settings → API → Legacy keys |
| `CRAWLER_SYSTEM_USER_ID` | UUID `f074e36d-a26f-44d8-8929-b23e6a2575e7` |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude Haiku 4.5 translation |

## Schema Extensions

Two SQL migrations must be applied before first run:

1. **`supabase/add_external_source_columns.sql`** — Adds to both `aircraft_listings` and `parts_listings`:
   - `source_name` (text) — source website identifier (e.g., "helmuts-ul-seiten.de")
   - `source_url` (text, unique index) — deduplication key (format: `pageUrl#index@date`)
   - `is_external` (boolean, default false) — scraped vs user-created flag

2. **`supabase/add_crawler_runs_table.sql`** — Creates `crawler_runs` table for admin monitoring:
   - Run status tracking (running/completed/failed)
   - Stats: pages processed, listings found/inserted/updated/skipped, errors
   - Image upload and translation counts
   - Duration, warnings, error messages, metadata (git SHA, run ID)

## Data Flow Per Listing

```
1. Fetch HTML page (with retry + 2s polite delay)
2. Parse into blocks (split by <hr> / "* * *" separators)
3. Extract fields via regex (German labels, bullet points)
4. Validate (price > 0, year in range, description not empty)
5. Check dedup (SELECT by source_url)
6. Download images → upload to Supabase Storage (listings/{uuid}.jpg)
7. Translate headline + description → 14 locales via Claude Haiku 4.5
8. Generate localized slugs (with Cyrillic/Greek/Turkish transliteration)
9. Upsert to Supabase (INSERT new / UPDATE existing)
10. Log run stats to crawler_runs table
```

## Supported Locales (14)

en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no

Source content is German (de). Claude Haiku translates to all 13 other languages per listing.

## Data Source: Helmut's UL Seiten

- **Aircraft pages**: verkauf1a.html, verkauf1b.html, verkauf1c.html
- **Parts page**: verkauf2.html
- HTML is unstructured (no CSS classes/IDs on listings)
- Listings separated by `<hr>` tags or `* * *` ASCII separators
- German text with bullet-point specs (•), obfuscated emails, German price format (€12.500,-)
- Aircraft specs: Baujahr, Motor, Betriebsstunden/TT, MTOW, Rettung, JNP, DULV Kennblatt
- Parts categories: Avionics (Navigationsgeräte), Engines (Motoren), Rescue (Rettungssysteme), Miscellaneous

## Key Design Decisions

1. **Service role key**: Bypasses RLS for backend ingestion; scraped listings inherit public read access from existing "active listings" RLS policies
2. **System user**: Dedicated profile (crawler@trade.aero) owns all scraped listings; prevents real users from editing external content via RLS user_id check
3. **Idempotency**: `source_url` unique index enables upsert-based deduplication — re-running the crawler updates existing listings instead of creating duplicates
4. **Cheerio over Puppeteer**: Source pages are static HTML, no JS rendering needed — faster, lighter, no browser dependency
5. **Polite crawling**: 2s delay between requests, proper User-Agent header, retry with exponential backoff
6. **Local image storage**: Images downloaded and re-hosted in Supabase Storage to avoid external dependencies; Next.js `<Image>` component auto-optimizes to WebP/AVIF at serve time
7. **Translation at crawl time**: Populates all 14 locale columns during ingestion so listings are immediately available in all languages on the website
8. **Run logging**: Every crawl execution is tracked in `crawler_runs` table for admin dashboard monitoring (success/failure, stats, duration)

## Database Tables Modified

| Table | Action | Columns Added |
|-------|--------|---------------|
| `aircraft_listings` | ALTER TABLE | `source_name`, `source_url`, `is_external` |
| `parts_listings` | ALTER TABLE | `source_name`, `source_url`, `is_external` |
| `crawler_runs` | CREATE TABLE | Full monitoring schema (20 columns) |

## Supabase Storage Buckets

| Bucket | Content | Access |
|--------|---------|--------|
| `aircraft-images` | Crawled aircraft listing photos | Public |
| `parts-images` | Crawled parts listing photos | Public |

File path pattern: `listings/{uuid}.jpg`

## Admin Dashboard

The crawler monitoring tab is at `/dashboard/admin/` → "Crawler" tab in the TradeAero-Refactor app. It reads from the `crawler_runs` table and displays:
- Summary cards (total runs, listings ingested, images, translations)
- Run history with status badges, detailed stats, error messages
- Filter by status and target, CSV export, pagination
