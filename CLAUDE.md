# TradeAero Crawler - Codebase Reference

## Overview

Standalone Node.js/TypeScript crawler that scrapes aircraft and parts listings from external aviation marketplaces and ingests them into the TradeAero Supabase database at https://refactor.trade.aero.

**Sources:**
- **Helmut's UL Seiten** (helmuts-ul-seiten.de) — German ultralight/microlight marketplace
- **Aircraft24.de** — Multi-category aircraft marketplace (SEP, MEP, turboprop, jet, helicopter)
- **Aeromarkt.net** — Europe's largest general aviation classifieds

The crawler downloads images to Supabase Storage, translates content into 14 languages via Claude Haiku 4.5, generates localized URL slugs, enriches listings with reference performance specs, and logs run history for admin dashboard monitoring.

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript 5
- **HTML Parsing**: Cheerio (static HTML, no headless browser needed)
- **Database**: Supabase PostgreSQL via `@supabase/supabase-js` (service role key bypasses RLS)
- **Translation**: Anthropic Claude Haiku 4.5 via `@anthropic-ai/sdk`
- **Image Storage**: Supabase Storage (`aircraft-images` and `parts-images` buckets)
- **Proxy**: Bright Data residential proxy via `https-proxy-agent` (for aircraft24.de, aeromarkt.net)
- **Scheduling**: GitHub Actions cron (3 independent workflows) + manual dispatch
- **Testing**: Vitest

## Project Structure

```
src/
  index.ts                        # CLI entry point (--source helmut|aircraft24|aeromarkt --target aircraft|parts|all)
  config.ts                       # Environment config, source URLs, proxy settings
  types.ts                        # Shared interfaces (ParsedAircraftListing, ParsedPartsListing, CrawlResult)
  crawlers/
    helmut-crawler.ts             # Helmut's UL Seiten orchestrator (aircraft + parts)
    aircraft24-crawler.ts         # Aircraft24.de orchestrator (index → model → detail, paginated)
    aeromarkt-crawler.ts          # Aeromarkt.net orchestrator (aircraft + parts categories)
    aircraft-crawler.ts           # (legacy) Original aircraft crawler
    parts-crawler.ts              # (legacy) Original parts crawler
  parsers/
    helmut-aircraft.ts            # Helmut aircraft HTML parser (unstructured, regex-based)
    helmut-parts.ts               # Helmut parts HTML parser (category detection)
    aircraft24.ts                 # Aircraft24 parser (index pages, model pages, pagination)
    aeromarkt.ts                  # Aeromarkt parser (listing pages, detail pages)
    aircraft.ts                   # (legacy) Original aircraft parser
    parts.ts                      # (legacy) Original parts parser
  db/
    client.ts                     # Supabase client (service role, no session persistence)
    aircraft.ts                   # Validate → resolve manufacturer → translate → upload images → enrich with ref specs → upsert
    parts.ts                      # Validate → translate → upload images → upsert parts_listings
    system-user.ts                # Lookup/cache system crawler user_id (crawler@trade.aero)
    crawler-runs.ts               # Log crawl start/complete/fail + stats + costs to crawler_runs table
    reference-specs.ts            # Lookup aircraft_reference_specs and apply missing performance data
  utils/
    fetch.ts                      # HTTP fetch with retry, exponential backoff, Bright Data proxy support, byte tracking
    html.ts                       # Email deobfuscation, price parsing, German date parsing, text cleaning
    images.ts                     # Download external images → upload to Supabase Storage (max 3 concurrent)
    translate.ts                  # Claude Haiku 4.5 translation to 14 locales with token tracking
    slug.ts                       # Localized slug generation (Cyrillic/Greek/Turkish transliteration)
    logger.ts                     # Structured logging with timestamp, level, context
  scripts/
    seed-reference-specs.ts       # Populate aircraft_reference_specs via Claude Haiku (200+ models)
supabase/
  add_external_source_columns.sql # Migration: source_name, source_url, is_external on listings tables
  add_crawler_runs_table.sql      # Migration: crawler_runs monitoring table
  add_cost_tracking_columns.sql   # Migration: proxy bytes + translation tokens on crawler_runs
  add_aircraft_reference_specs.sql # Migration: reference performance specs table
.github/workflows/
  crawl-helmut.yml                # Daily 06:00 UTC — Helmut's UL Seiten (no proxy)
  crawl-aircraft24.yml            # Daily 07:00 UTC — Aircraft24.de (Bright Data proxy)
  crawl-aeromarkt.yml             # Daily 08:00 UTC — Aeromarkt.net (Bright Data proxy)
  seed-reference-specs.yml        # Manual — seed aircraft_reference_specs via Claude Haiku
```

## Commands

```bash
npm run dev                    # Run crawler (default: helmut, all targets)
npm run crawl:helmut           # Crawl Helmut's UL Seiten (aircraft + parts)
npm run crawl:helmut:aircraft  # Crawl Helmut aircraft only
npm run crawl:helmut:parts     # Crawl Helmut parts only
npm run crawl:aircraft24       # Crawl Aircraft24.de
npm run crawl:aeromarkt        # Crawl Aeromarkt.net
npm run crawl:all              # Crawl all 3 sources sequentially
npm run seed:reference-specs   # Populate reference specs table via Claude Haiku
npm run build                  # Compile TypeScript to dist/
npm run start                  # Run compiled JS (dist/index.js)
npm test                       # Run vitest unit tests
npm run test:watch             # Run vitest in watch mode
```

## CLI Arguments

```bash
node dist/index.js --source helmut --target aircraft
node dist/index.js --source aircraft24 --target all
node dist/index.js --source aeromarkt --target parts
```

- `--source`: `helmut` (default), `aircraft24`, `aeromarkt`
- `--target`: `all` (default), `aircraft`, `parts`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role JWT (bypasses RLS) |
| `ANTHROPIC_API_KEY` | Yes | Claude Haiku 4.5 API key for translation |
| `BRIGHT_DATA_PROXY_URL` | No | Bright Data proxy URL (`http://user:pass@brd.superproxy.io:22225`) |
| `CRAWLER_SYSTEM_USER_ID` | No | UUID of crawler profile (looked up by email if not set) |
| `CRAWLER_USER_AGENT` | No | HTTP User-Agent (default: `TradeAero-Crawler/1.0`) |
| `CRAWL_DELAY_MS` | No | Delay between requests in ms (default: 2000) |

## GitHub Actions Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (legacy JWT) |
| `CRAWLER_SYSTEM_USER_ID` | `f074e36d-a26f-44d8-8929-b23e6a2575e7` |
| `ANTHROPIC_API_KEY` | Anthropic API key for translation |
| `BRIGHT_DATA_PROXY_URL` | Bright Data residential proxy URL |

## GitHub Actions Workflows

| Workflow | Source | Cron | Proxy | Timeout |
|----------|--------|------|-------|---------|
| Crawl Helmut's UL Seiten | helmuts-ul-seiten.de | 06:00 UTC daily | No | 60 min |
| Crawl Aircraft24.de | aircraft24.de | 07:00 UTC daily | Yes | 60 min |
| Crawl Aeromarkt.net | aeromarkt.net | 08:00 UTC daily | Yes | 60 min |
| Seed Aircraft Reference Specs | — | Manual only | No | 5 min |

## Schema Extensions (4 SQL migrations)

Run in order in Supabase SQL Editor:

1. **`add_external_source_columns.sql`** — `source_name`, `source_url`, `is_external` on `aircraft_listings` + `parts_listings`
2. **`add_crawler_runs_table.sql`** — `crawler_runs` monitoring table
3. **`add_cost_tracking_columns.sql`** — `proxy_bytes_transferred`, `translation_input_tokens`, `translation_output_tokens` on `crawler_runs`
4. **`add_aircraft_reference_specs.sql`** — `aircraft_reference_specs` reference performance data table

## Data Flow Per Listing

```
1. Fetch HTML page (retry 3x, polite 2-3s delay, optional Bright Data proxy)
2. Parse into blocks (source-specific parser: regex, Cheerio selectors)
3. Extract fields (title, year, price, engine, location, images, contact)
4. Validate (year in range, description not empty)
5. Check dedup (SELECT by source_url unique index)
6. Resolve manufacturer (dynamic lookup from aircraft_manufacturers table)
7. Detect category (LSA for ultralights, helicopter for gyrocopters, etc.)
8. Download images → upload to Supabase Storage (listings/{uuid}.jpg)
9. Translate headline + description → 14 locales via Claude Haiku 4.5
10. Generate localized slugs (Cyrillic/Greek/Turkish transliteration)
11. Enrich with reference specs (performance, weights, engine, seats, fuel)
12. Upsert to Supabase (INSERT new / UPDATE existing)
13. Log run stats + costs to crawler_runs table
```

## Aircraft Reference Specs Enrichment

The `aircraft_reference_specs` table stores standard performance data for 200+ aircraft models across all categories (UL/LSA, SEP, MEP, turboprop, jet, helicopter, experimental).

- **Seeded by**: Claude Haiku 4.5 via `seed-reference-specs.ts` script
- **Lookup**: Fuzzy matching against listing title (manufacturer + model keywords)
- **Applied fields**: cruise_speed, max_speed, range, ceiling, climb_rate, takeoff/landing distance, fuel_consumption, weights, engine_type, engine_power, fuel_type, seats, fuel_capacity
- **Rule**: Only fills null/missing fields — never overwrites data extracted from the listing

## Supported Locales (14)

en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no

Source content is German (de). Claude Haiku translates to all 13 other languages.

## Cost Tracking

| Service | Pricing | Tracked in |
|---------|---------|------------|
| Bright Data residential proxy | ~$8.40/GB | `crawler_runs.proxy_bytes_transferred` |
| Claude Haiku 4.5 (input) | $0.80/MTok | `crawler_runs.translation_input_tokens` |
| Claude Haiku 4.5 (output) | $4.00/MTok | `crawler_runs.translation_output_tokens` |

Costs are displayed in the admin dashboard at `/dashboard/admin/` → Crawler tab.

## Data Sources

### Helmut's UL Seiten (helmuts-ul-seiten.de)
- Aircraft: verkauf1a.html, verkauf1b.html, verkauf1c.html
- Parts: verkauf2.html
- Unstructured HTML (no CSS classes/IDs), `<hr>` separated listings
- German text, bullet-point specs, obfuscated emails, German price format
- **No proxy needed** (no anti-bot)

### Aircraft24.de
- Categories: singleprop, multiprop, turboprop, jet, helicopter
- Structured listing pages with pagination ("Seite X von Y")
- Index → model → detail page navigation
- **Proxy recommended** (rate limiting)

### Aeromarkt.net
- Categories: Kolbenmotorflugzeuge, Jets & Turboprops, Helikopter, Leichtflugzeuge, Experimentals, Sonstige
- Parts: Triebwerke, Avionik & Instrumente
- **Proxy recommended** (Envoy proxy protection)

## Key Design Decisions

1. **Service role key**: Bypasses RLS; scraped listings readable via existing "active listings" policies
2. **System user** (`crawler@trade.aero`): Owns all scraped listings; RLS prevents real users from editing
3. **Idempotency**: `source_url` unique index enables upsert deduplication
4. **Cheerio over Puppeteer**: All source pages are static HTML
5. **Polite crawling**: 2-3s delay, proper User-Agent, retry with backoff
6. **Local image storage**: Re-hosted in Supabase Storage; Next.js auto-optimizes to WebP/AVIF
7. **Translation at crawl time**: All 14 locales populated during ingestion
8. **Reference spec enrichment**: Missing performance data filled from curated reference table
9. **Independent workflows**: Each source has its own cron schedule and can be triggered separately
10. **Cost tracking**: Proxy bandwidth and translation tokens tracked per run for admin visibility
11. **Bright Data proxy**: Configurable per source; Helmut doesn't need it, aircraft24/aeromarkt do

## Database Tables

| Table | Operation | Purpose |
|-------|-----------|---------|
| `aircraft_listings` | INSERT/UPDATE | Crawled aircraft listings (+ source_name, source_url, is_external columns) |
| `parts_listings` | INSERT/UPDATE | Crawled parts listings (+ source_name, source_url, is_external columns) |
| `crawler_runs` | INSERT/UPDATE | Run monitoring (status, stats, costs, duration, errors) |
| `aircraft_reference_specs` | SELECT | Reference performance data lookup |
| `aircraft_manufacturers` | SELECT | Manufacturer ID resolution |
| `profiles` | SELECT | System user ID lookup |

## Supabase Storage Buckets

| Bucket | Content | Access |
|--------|---------|--------|
| `aircraft-images` | Aircraft listing photos | Public |
| `parts-images` | Parts listing photos | Public |

Path pattern: `listings/{uuid}.jpg`

## Admin Dashboard

Crawler monitoring tab at `/dashboard/admin/` → "Crawler" tab:
- **Trigger buttons**: Helmut UL, Aircraft24, Aeromarkt, Crawl All
- **Cost cards**: Proxy bandwidth ($), translation tokens ($), total cost
- **Summary cards**: Runs, listings, images, translations
- **Run history**: Status badges, per-run stats + cost, errors, warnings
- **Filters**: By source, status, target
- **Export**: CSV download
