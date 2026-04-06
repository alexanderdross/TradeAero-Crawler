# TradeAero Crawler - Codebase Reference

## Overview

Standalone Node.js/TypeScript crawler that scrapes aircraft and parts listings from external aviation marketplaces and ingests them into the TradeAero Supabase database at https://refactor.trade.aero.

**Sources:**
- **Helmut's UL Seiten** (helmuts-ul-seiten.de) -- German ultralight/microlight marketplace
- **Aircraft24.de** -- Multi-category aircraft marketplace (SEP, MEP, turboprop, jet, helicopter)
- **Aeromarkt.net** -- Europe's largest general aviation classifieds

The crawler downloads images to Supabase Storage, translates content into 14 languages via Claude Haiku 4.5, generates localized URL slugs, enriches listings with reference performance specs, and logs run history for admin dashboard monitoring.

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript 5
- **HTML Parsing**: Cheerio (static HTML, no headless browser needed)
- **Database**: Supabase PostgreSQL via `@supabase/supabase-js` (service role key bypasses RLS)
- **Translation**: Anthropic Claude Haiku 4.5 via `@anthropic-ai/sdk`
- **Image Storage**: Supabase Storage (`aircraft-images` and `parts-images` buckets)
- **Proxy**: Bright Data residential proxy via `https-proxy-agent` (for aircraft24.de, aeromarkt.net)
- **Scheduling**: GitHub Actions cron (3 independent workflows) + manual dispatch
- **Testing**: Vitest (107 tests across 4 files)

## Project Structure

```
src/
  index.ts                        # CLI entry point (--source helmut|aircraft24|aeromarkt --target aircraft|parts|all)
  config.ts                       # Environment config, source URLs, proxy settings (per-source useProxy flag)
  types.ts                        # Shared interfaces (ParsedAircraftListing, ParsedPartsListing, CrawlResult)
  crawlers/
    helmut-crawler.ts             # Helmut's UL Seiten orchestrator (aircraft + parts)
    aircraft24-crawler.ts         # Aircraft24.de orchestrator (index -> model -> detail, paginated)
    aeromarkt-crawler.ts          # Aeromarkt.net orchestrator (aircraft + parts categories)
    aircraft-crawler.ts           # (legacy) Original aircraft crawler
    parts-crawler.ts              # (legacy) Original parts crawler
  parsers/
    helmut-aircraft.ts            # Helmut aircraft HTML parser (unstructured, regex-based)
    helmut-parts.ts               # Helmut parts HTML parser (category detection)
    aircraft24.ts                 # Aircraft24 parser (index pages, model pages, pagination)
    aeromarkt.ts                  # Aeromarkt parser (listing pages, detail pages)
    shared.ts                     # 7 extracted shared functions (splitIntoBlocks, isNavigationBlock, extractTitle, extractPriceFromText, extractContact, extractImages, extractLocation)
    aircraft.ts                   # (legacy) Original aircraft parser
    parts.ts                      # (legacy) Original parts parser
  db/
    client.ts                     # Supabase client (service role, no session persistence)
    aircraft.ts                   # Validate -> resolve manufacturer -> translate -> upload images -> enrich with ref specs -> upsert
    parts.ts                      # Validate -> translate -> upload images -> upsert parts_listings
    locale-helpers.ts             # LANGS constant (14 locales) + buildLocaleFields() for headline/description/slug generation
    system-user.ts                # Lookup/cache system crawler user_id (crawler@trade.aero)
    crawler-runs.ts               # Log crawl start/complete/fail + stats + costs to crawler_runs table
    reference-specs.ts            # Lookup aircraft_reference_specs and apply missing performance data
  utils/
    fetch.ts                      # HTTP fetch with retry, exponential backoff, Bright Data proxy support, byte tracking
    html.ts                       # Email deobfuscation, price parsing, German date parsing, cleanText(), sanitizeForDb()
    images.ts                     # Download external images -> upload to Supabase Storage (max 5 concurrent, domain allowlist, magic byte validation)
    translate.ts                  # Claude Haiku 4.5 translation to 14 locales with token tracking + LLM output sanitization
    slug.ts                       # Localized slug generation (Cyrillic/Greek/Turkish transliteration)
    logger.ts                     # Structured logging with timestamp, level, context; LOG_LEVEL env var support
  scripts/
    seed-reference-specs.ts       # Populate aircraft_reference_specs via Claude Haiku (475 models)
  __tests__/
    slug.test.ts                  # Slug generation tests
    parsers.test.ts               # Parser tests (Helmut aircraft + parts)
    html-utils.test.ts            # HTML utility tests
    html-utils-extended.test.ts   # Extended HTML utility tests (sanitization, edge cases)
supabase/
  add_external_source_columns.sql # Migration: source_name, source_url, is_external on listings tables
  add_crawler_runs_table.sql      # Migration: crawler_runs monitoring table
  add_cost_tracking_columns.sql   # Migration: proxy bytes + translation tokens on crawler_runs
  add_aircraft_reference_specs.sql # Migration: reference performance specs table
  fix_reference_specs_categories.sql # Migration: fix category assignments in reference specs
.github/workflows/
  crawl-helmut.yml                # Daily 06:00 UTC -- Helmut's UL Seiten (no proxy)
  crawl-aircraft24.yml            # Daily 07:00 UTC -- Aircraft24.de (Bright Data proxy)
  crawl-aeromarkt.yml             # Daily 08:00 UTC -- Aeromarkt.net (Bright Data proxy)
  seed-reference-specs.yml        # Manual -- seed aircraft_reference_specs via Claude Haiku
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
npm test                       # Run vitest unit tests (107 tests)
npm run test:watch             # Run vitest in watch mode
npm run lint                   # ESLint
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
| `ANTHROPIC_API_KEY` | No | Claude Haiku 4.5 API key for translation (warns + skips if missing) |
| `BRIGHT_DATA_PROXY_URL` | No | Bright Data proxy URL (`http://user:pass@brd.superproxy.io:22225`) |
| `CRAWLER_SYSTEM_USER_ID` | No | UUID of crawler profile (looked up by email if not set) |
| `CRAWLER_USER_AGENT` | No | HTTP User-Agent (default: Chrome 131 browser string) |
| `CRAWL_DELAY_MS` | No | Delay between requests in ms (default: 2000) |
| `LOG_LEVEL` | No | Logging verbosity: `debug`, `info` (default), `warn`, `error` |

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
| Seed Aircraft Reference Specs | -- | Weekly Sun 7AM + Manual | No | 60 min |

All crawler workflows use quoted workflow input interpolation (`"${{ github.event.inputs.target || 'all' }}"`) to prevent injection.

## Schema Extensions (5 SQL migrations)

Run in order in Supabase SQL Editor:

1. **`add_external_source_columns.sql`** -- `source_name`, `source_url`, `is_external` on `aircraft_listings` + `parts_listings`
2. **`add_crawler_runs_table.sql`** -- `crawler_runs` monitoring table
3. **`add_cost_tracking_columns.sql`** -- `proxy_bytes_transferred`, `translation_input_tokens`, `translation_output_tokens` on `crawler_runs`
4. **`add_aircraft_reference_specs.sql`** -- `aircraft_reference_specs` reference performance data table
5. **`fix_reference_specs_categories.sql`** -- Fix category assignments in reference specs

## Security Measures

From the 12-agent security assessment:

| Measure | CWE | Implementation |
|---------|-----|----------------|
| HTML tag stripping (XSS prevention) | CWE-79 | `cleanText()` + `sanitizeForDb()` in `src/utils/html.ts` |
| Image domain allowlist (SSRF prevention) | CWE-918 | `ALLOWED_IMAGE_DOMAINS` in `src/utils/images.ts` |
| Image magic byte validation (JPEG/PNG) | CWE-434 | `isValidImage()` checks first 4 bytes |
| 10MB size limits on pages and images | CWE-400 | `MAX_PAGE_SIZE` / `MAX_IMAGE_SIZE` constants |
| 30s AbortSignal timeout on all fetch calls | CWE-400 | `FETCH_TIMEOUT_MS` in `src/utils/fetch.ts` |
| LLM translation output sanitization | CWE-79 | HTML tag stripping on translated text in `src/utils/translate.ts` |
| Quoted workflow input interpolation | CWE-78 | `"${{ github.event.inputs.target }}"` in all workflow files |

## Anonymous Crawling

- **Default User-Agent**: Chrome 131 browser string (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...Chrome/131.0.0.0...`)
- **Browser-like headers**: `Sec-Fetch-Dest`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Sec-Fetch-User`, `Accept-Encoding`, `Upgrade-Insecure-Requests`
- **No referrer**: `Referer: ""` header sent on all requests
- **Configurable**: Override via `CRAWLER_USER_AGENT` env var

## Data Flow Per Listing

```
1. Fetch HTML page (retry 3x, polite 2-3s delay, optional Bright Data proxy)
2. Parse into blocks (source-specific parser: regex, Cheerio selectors)
3. Extract fields (title, year, price, engine, location, images, contact)
4. Validate (year in range, description 10+ chars after HTML strip; fallback to title or "Title — Year")
5. Check dedup (SELECT by source_url unique index)
6. Resolve manufacturer (DB lookup -> reference_specs -> KNOWN_MANUFACTURERS -> fallback)
7. Detect category (engine-based: Rotax->LSA, Lycoming->SEP; 15 categories total)
8. Download images -> upload to Supabase Storage (listings/{uuid}.jpg)
9. Translate headline + description -> 14 locales via Claude Haiku 4.5
10. Generate localized slugs (Cyrillic/Greek/Turkish transliteration)
11. Enrich with reference specs (performance, weights, engine, seats, fuel)
12. Upsert to Supabase (INSERT new / UPDATE existing)
13. Log run stats + costs to crawler_runs table
```

## Aircraft Categories (15)

| ID | Category | Detection Method |
|----|----------|-----------------|
| 1 | Single Engine Piston | Lycoming/Continental engine keywords |
| 2 | Multi Engine Piston | Twin/multi keywords, model patterns |
| 3 | Very Light Jet | VLJ, Eclipse, SF50 |
| 4 | Light Jet | CJ series, Phenom 100, HondaJet |
| 5 | Mid-Size Jet | XLS, Latitude, Hawker |
| 6 | Super Mid-Size Jet | Longitude, Challenger, Praetor |
| 7 | Heavy Jet | G-series, Global, Falcon 6-8 |
| 8 | Ultra Long Range | G700, Global 7 |
| 9 | Turboprop | PT6, King Air, TBM, PC-12 |
| 10 | Helicopter | Helicopter/gyrocopter manufacturers and keywords |
| 11 | Light Sport Aircraft | Rotax/Jabiru engine keywords, UL manufacturers |
| 12 | Commercial Airliner | -- |
| 13 | Other | Experimental manufacturers |
| 14 | Glider | Motorsegler, glider, TMG keywords |
| 15 | Microlight / Flex-Wing | Paramotor, trike, flex-wing keywords |

## Manufacturer Resolution (5-tier)

1. **DB lookup** (`aircraft_manufacturers` table) — HIGH confidence
2. **Reference specs** (`aircraft_reference_specs` unique manufacturers) — HIGH confidence
3. **KNOWN_MANUFACTURERS list** (100+ hardcoded names) — MEDIUM confidence
4. **URL hint** (manufacturer name extracted from source URL path) — MEDIUM confidence
5. **Fallback** (`"Other"` manufacturer entry) — LOW confidence → logged to `admin_activity_logs`

### Unresolved Manufacturer Handling
When manufacturer confidence is `"low"` (Tier 5 fallback):
- Listing is **published as active** if it has images (images alone prove content quality)
- Listing is saved as **draft** only if it has **both** no images AND low-confidence manufacturer
- `recordUnresolvedManufacturer()` seeds `aircraft_reference_specs` with a low-confidence placeholder. Next crawl run re-resolves the listing via Tier 2 lookup.
- Manufacturer name guessed using language-agnostic extraction: strips common listing prefixes (DE/EN/FR/ES/NL/IT sale verbs + adjectives), takes first 1–2 capitalized tokens

## Draft/Active Status Matrix

| Scenario | Status |
|----------|--------|
| Has images + known manufacturer | active |
| Has images + unknown manufacturer | active (manufacturer seeded for next run) |
| No images + known manufacturer | active |
| No images + unknown manufacturer | **draft** (genuinely incomplete) |

## Data Quality Rules

- **Price**: `null` for missing (not 0); `price_negotiable` only when VB/VHB explicitly present
- **TTSN**: `null` when 0 or missing (shows N/A in UI)
- **Description**: Must be 10+ chars after HTML stripping; falls back to title, then `"Title — Year"`; listing skipped if still too short
- **Date prefix**: Stripped from headlines and slugs (`17.02.2025 Cessna...` -> `Cessna...`)
- **Slugs**: DB-generated with `listing_number` suffix on INSERT; localized slugs set after
- **Draft condition**: No images AND unknown manufacturer (both required — either alone → active)
- **Low confidence manufacturer**: Logged to `admin_activity_logs`; `aircraft_reference_specs` seeded for auto-resolution on next crawl
- **Constraint violations**: DB check-constraint errors (e.g. `description_check`) logged as WARN, not ERROR; listing gracefully skipped

## Aircraft Reference Specs Enrichment

The `aircraft_reference_specs` table stores standard performance data for **475 aircraft models** across all categories (UL/LSA, SEP, MEP, turboprop, jets, helicopters, gyrocopters, experimental, gliders, trikes).

- **Seeded by**: Claude Haiku 4.5 via `seed-reference-specs.ts` script (GitHub Actions workflow)
- **Lookup**: Fuzzy scoring against listing title (manufacturer +2, model +3, variant +1; threshold >= 3)
- **Applied fields**: cruise_speed, max_speed, range, ceiling, climb_rate, takeoff/landing distance, fuel_consumption, weights, engine_type, engine_power, fuel_type, seats, fuel_capacity
- **Rule**: Only fills null/missing fields -- never overwrites data extracted from the listing

## Per-Locale Image Alt Text

Images are stored in `ImageWithMeta` format with per-locale alt text fields:
- `alt_text_en`, `alt_text_de`, `alt_text_fr`, etc. (all 14 locales)
- Alt text uses translated headlines: `"{translated headline} - Image {n}"`
- Each image also has `url`, `alt_text` (default), `auto_translate`, `sort_order`

## Image Sitemap

Aircraft sitemaps include `<image:image>` entries for each listing's images.

## Supported Locales (14)

en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no

Source content is German (de). Claude Haiku translates to all 13 other languages.

## Cost Tracking

| Service | Pricing | Tracked in |
|---------|---------|------------|
| Bright Data residential proxy | ~$8.40/GB | `crawler_runs.proxy_bytes_transferred` |
| Claude Haiku 4.5 (input) | $1.00/MTok | `crawler_runs.translation_input_tokens` |
| Claude Haiku 4.5 (output) | $5.00/MTok | `crawler_runs.translation_output_tokens` |

Costs are displayed in the admin dashboard at `/dashboard/admin/` -> Crawler tab.

## Unit Tests

107 tests across 4 files:
- `slug.test.ts` -- Slug generation, transliteration (Cyrillic, Greek, Turkish)
- `parsers.test.ts` -- Helmut aircraft + parts HTML parsing
- `html-utils.test.ts` -- Email decoding, price parsing, date parsing, text cleaning
- `html-utils-extended.test.ts` -- sanitizeForDb, edge cases, XSS prevention

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
- Index -> model -> detail page navigation
- **Proxy required** (rate limiting)

### Aeromarkt.net
- Aircraft: Kolbenmotorflugzeuge, Jets & Turboprops, Helikopter & Gyrocopter, Leichtflugzeuge, Experimentals & Classics, Sonstige
- Parts: Triebwerke, Avionik & Instrumente
- **Proxy required** (Envoy proxy protection)

## Admin Dashboard

Crawler monitoring tab at `/dashboard/admin/` -> "Crawler" tab:
- **Trigger buttons**: Helmut UL, Aircraft24, Aeromarkt, Crawl All
- **GitHub Actions hyperlink**: Links to workflow runs
- **Source health cards**: Per-source stats and status
- **Cost cards**: Proxy bandwidth ($), translation tokens ($), total cost
- **Per-source listing breakdown**: Listings by source
- **Recent errors panel**: Error details from latest runs
- **Run history**: Status badges, per-run stats + cost
- **Filters**: By source, status, target
- **CSV export**

## Database Tables

| Table | Operation | Purpose |
|-------|-----------|---------|
| `aircraft_listings` | INSERT/UPDATE | Crawled aircraft listings (+ source_name, source_url, is_external columns) |
| `parts_listings` | INSERT/UPDATE | Crawled parts listings (+ source_name, source_url, is_external columns) |
| `crawler_runs` | INSERT/UPDATE | Run monitoring (status, stats, costs, duration, errors) |
| `aircraft_reference_specs` | SELECT | Reference performance data lookup (475 models) |
| `aircraft_manufacturers` | SELECT/INSERT | Manufacturer ID resolution (auto-created when new manufacturer found) |
| `profiles` | SELECT | System user ID lookup |
| `admin_activity_logs` | INSERT | Draft listing notifications for admin review |

## Supabase Storage Buckets

| Bucket | Content | Access |
|--------|---------|--------|
| `aircraft-images` | Aircraft listing photos | Public |
| `parts-images` | Parts listing photos | Public |

Path pattern: `listings/{uuid}.jpg`

## Key Design Decisions

1. **Service role key**: Bypasses RLS; scraped listings readable via existing "active listings" policies
2. **System user** (`crawler@trade.aero`): Owns all scraped listings; RLS prevents real users from editing
3. **Idempotency**: `source_url` unique index enables upsert deduplication
4. **Cheerio over Puppeteer**: All source pages are static HTML
5. **Polite crawling**: 2-3s delay, browser-like User-Agent and headers, retry with backoff
6. **Local image storage**: Re-hosted in Supabase Storage; Next.js auto-optimizes to WebP/AVIF
7. **Translation at crawl time**: All 14 locales populated during ingestion
8. **Reference spec enrichment**: Missing performance data filled from curated reference table (475 models)
9. **Independent workflows**: Each source has its own cron schedule and can be triggered separately
10. **Cost tracking**: Proxy bandwidth and translation tokens tracked per run for admin visibility
11. **Bright Data proxy**: Configurable per source; Helmut doesn't need it, aircraft24/aeromarkt do
12. **Image-first publishing**: Listings with images always publish as active regardless of manufacturer confidence; only no-image + no-manufacturer listings are saved as draft
13. **Manufacturer auto-seed**: Unresolved manufacturers seeded into `aircraft_reference_specs` as low-confidence placeholders; next crawl auto-resolves via Tier 2 lookup
14. **Manufacturer auto-create**: New manufacturers discovered during crawling are created in aircraft_manufacturers table
15. **Graceful constraint handling**: DB constraint violations (e.g. `description_check`) downgraded from ERROR to WARN, listing skipped without aborting the run
