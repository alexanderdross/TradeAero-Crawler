# TradeAero Crawler - Codebase Reference

## Overview
Standalone Node.js/TypeScript crawler that scrapes aircraft and parts listings from external aviation marketplaces (currently Helmut's UL Seiten) and ingests them into the TradeAero Supabase database.

## Tech Stack
- **Runtime**: Node.js 20+, TypeScript 5
- **HTML Parsing**: Cheerio (static HTML, no browser needed)
- **Database**: Supabase (PostgreSQL via @supabase/supabase-js, service role key)
- **Scheduling**: GitHub Actions cron (daily 06:00 UTC)

## Project Structure
```
src/
  index.ts              # CLI entry point (--target aircraft|parts|all)
  config.ts             # Environment config, source URLs
  types.ts              # Shared TypeScript interfaces
  crawlers/
    aircraft-crawler.ts # Orchestrates aircraft crawl + upsert loop
    parts-crawler.ts    # Orchestrates parts crawl + upsert loop
  parsers/
    aircraft.ts         # Parses unstructured HTML → ParsedAircraftListing[]
    parts.ts            # Parses unstructured HTML → ParsedPartsListing[]
  db/
    client.ts           # Supabase service-role client
    aircraft.ts         # Upsert aircraft_listings (dedup via source_url)
    parts.ts            # Upsert parts_listings (dedup via source_url)
    system-user.ts      # Lookup/cache system crawler user_id
  utils/
    fetch.ts            # HTTP fetch with retry + polite delay
    html.ts             # Email deobfuscation, price parsing, German dates
    logger.ts           # Structured logging
supabase/
  add_external_source_columns.sql  # Schema migration (source_name, source_url, is_external)
.github/workflows/
  crawl.yml             # Daily cron + manual dispatch
```

## Commands
```bash
npm run dev             # Run crawler (all targets) via tsx
npm run crawl:aircraft  # Crawl aircraft only
npm run crawl:parts     # Crawl parts only
npm run crawl:all       # Crawl everything
npm run build           # Compile TypeScript
npm run start           # Run compiled JS
npm test                # Run vitest
```

## Environment Variables
```
SUPABASE_URL              # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY # Service role key (bypasses RLS)
CRAWLER_SYSTEM_USER_ID    # UUID of crawler system profile (optional, looked up by email if missing)
CRAWLER_USER_AGENT        # HTTP User-Agent header (default: TradeAero-Crawler/1.0)
CRAWL_DELAY_MS            # Delay between page fetches in ms (default: 2000)
```

## Schema Extensions
Before first run, apply `supabase/add_external_source_columns.sql` to add:
- `source_name` (text) – source website identifier
- `source_url` (text, unique index) – deduplication key
- `is_external` (boolean) – scraped vs user-created flag

These are added to both `aircraft_listings` and `parts_listings`.

## Data Source: Helmut's UL Seiten
- Aircraft: verkauf1a.html, verkauf1b.html, verkauf1c.html
- Parts: verkauf2.html
- HTML is unstructured (no classes/IDs), listings separated by `<hr>` tags
- German text with bullet-point specs, obfuscated emails, German price formats

## Key Design Decisions
1. **Service role key**: Bypasses RLS for backend ingestion; scraped listings inherit public read access from existing "active listings" RLS policies
2. **System user**: Dedicated profile (crawler@trade.aero) owns all scraped listings; prevents real users from editing external content
3. **Idempotency**: `source_url` unique index enables upsert-based deduplication
4. **Cheerio over Puppeteer**: Source pages are static HTML, no JS rendering needed
5. **Polite crawling**: 2s delay between requests, proper User-Agent header
