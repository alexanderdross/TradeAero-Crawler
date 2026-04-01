# TradeAero Crawler - Architecture & Operations Guide

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Crawl Pipeline](#crawl-pipeline)
3. [HTML Parsing Strategy](#html-parsing-strategy)
4. [Data Normalization](#data-normalization)
5. [Image Pipeline](#image-pipeline)
6. [Translation Pipeline](#translation-pipeline)
7. [Slug Generation](#slug-generation)
8. [Database Integration](#database-integration)
9. [Deduplication & Idempotency](#deduplication--idempotency)
10. [Run Monitoring](#run-monitoring)
11. [Error Handling & Validation](#error-handling--validation)
12. [GitHub Actions Workflow](#github-actions-workflow)
13. [Adding New Sources](#adding-new-sources)
14. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     GitHub Actions (cron 06:00 UTC)              │
│                     or manual workflow_dispatch                   │
└─────────────────────────┬────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│  src/index.ts — CLI entry point (--target aircraft|parts|all)    │
└─────────────────────────┬────────────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
┌──────────────────────┐   ┌──────────────────────┐
│  aircraft-crawler.ts │   │  parts-crawler.ts    │
│  (3 pages)           │   │  (1 page)            │
└──────────┬───────────┘   └──────────┬───────────┘
           │                          │
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│  parsers/aircraft.ts │   │  parsers/parts.ts    │
│  HTML → structured   │   │  HTML → structured   │
│  (regex extraction)  │   │  (category detect)   │
└──────────┬───────────┘   └──────────┬───────────┘
           │                          │
           └──────────┬───────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  Per-listing pipeline:                                           │
│  1. Validate (price, year, description)                          │
│  2. Check dedup (source_url unique index)                        │
│  3. Download images → Supabase Storage (utils/images.ts)         │
│  4. Translate 14 locales → Claude Haiku 4.5 (utils/translate.ts) │
│  5. Generate localized slugs (utils/slug.ts)                     │
│  6. Upsert to Supabase (db/aircraft.ts | db/parts.ts)           │
└──────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  crawler_runs table — log start/complete/fail + stats            │
└──────────────────────────────────────────────────────────────────┘
```

---

## Crawl Pipeline

### Entry Point (`src/index.ts`)

1. Validates environment config (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
2. Parses CLI target: `--target aircraft|parts|all`
3. Executes crawlers sequentially (aircraft first, then parts)
4. Prints summary table and exits with code 1 if any errors occurred

### Crawler Orchestrator (per target)

Each crawler (`aircraft-crawler.ts`, `parts-crawler.ts`) follows the same pattern:

1. **Start run** — Insert a `running` record in `crawler_runs`
2. **Get system user** — Lookup `crawler@trade.aero` profile UUID (cached after first call)
3. **For each source page URL**:
   a. Fetch HTML with retry (3 attempts, exponential backoff)
   b. Parse HTML into structured listing objects
   c. For each parsed listing → validate → dedup check → upload images → translate → upsert
   d. Polite 2s delay before next page
4. **Complete run** — Update `crawler_runs` with final stats (or mark as failed on exception)

---

## HTML Parsing Strategy

### The Challenge

Helmut's UL Seiten uses unstructured HTML with no CSS classes, no IDs, and no semantic markup on individual listings. Listings are free-form text blocks separated by visual dividers.

### Block Splitting (`splitIntoBlocks`)

```
Page HTML
    │
    ├── Split on <hr> tags (various formats: <hr>, <hr/>, <hr />)
    │
    ├── Further split on "* * *" ASCII separators within blocks
    │
    └── Filter: keep blocks with >50 chars of text content
```

### Aircraft Field Extraction

Each block is parsed with regex patterns for German aviation terminology:

| Field | Regex Pattern | Example Match |
|-------|--------------|---------------|
| Date | `\d{2}\.\d{2}\.\d{4}` | `31.03.2026` |
| Title | First `<b>`/`<strong>` text, or first significant line | `FK 131 Baujahr: 2022` |
| Year | `Baujahr[:\s]*(\d{4})` | `Baujahr: 2022` → `2022` |
| Engine | `Motor[:\s]*([^•\n]+)` | `Motor: Rotax 912ULS 100 PS` |
| Flight hours | `(?:Betriebsstunden\|TT\|Flugstunden)[:\s]*([\d.,]+)` | `TT: 450` |
| MTOW | `MTOW[:\s]*([\d.,]+)\s*kg` | `MTOW: 472,5 kg` |
| Rescue system | `Rettung[:\s]*([^•\n]+)` | `Rettung: Junkers Magnum 450` |
| Annual inspection | `(?:JNP\|Jahresnachprüfung)[:\s]*...` | `JNP: 12/2025` |
| DULV ref | `DULV[- ]?Kennblatt[:\s]*...` | `DULV-Kennblatt: Nr. 1234` |
| Price | `€\s*([\d.,]+)\s*,?-?\s*(VB\|VHB\|FP)?` | `€12.500,- VB` |
| Email | `mailto:` links (hex-decoded) or `[at]` patterns | `name[at]domain.de` |
| Phone | `(?:Tel\.?\|Telefon\|Mobil)[:\s]*([\d\s/+()-]+)` | `Tel. 0171/1234567` |
| Location | `(?:Standort\|Raum\|Region)[:\s]*...` or postal code + city | `Standort: Raum München` |
| Images | All `<img>` tags with width/height > 50px | Absolute URLs constructed from relative paths |

### Parts Category Detection

Parts are categorized by section headers and keyword matching:

| Category | Detection Keywords |
|----------|-------------------|
| `avionics` | Navigationsgerät, Funkgerät, Transponder, GPS, Garmin, Becker, FLARM |
| `engines` | Motor, Rotax, Getriebe, Propeller, Vergaser, Auspuff |
| `rescue` | Rettung, Rettungsgerät, Rettungssystem, Fallschirm, BRS |
| `miscellaneous` | Everything else |

### Email Deobfuscation

Helmut's pages use multiple email obfuscation techniques:

1. **Hex encoding**: `%66ly2dr%69me` → decode `%xx` sequences → `fly2drime`
2. **[at] replacement**: `name[at]domain.de` → `name@domain.de`
3. **Combined**: `mailto:` links with hex-encoded characters + `[at]` in display text

### German Price Parsing

Handles German number formatting where `.` is thousands separator and `,` is decimal:

| Input | Parsed |
|-------|--------|
| `€12.500,-` | `12500` |
| `€ 8.900 VB` | `8900` (negotiable) |
| `15000 EUR FP` | `15000` (fixed price) |
| `Preis: 3.500,50` | `3500.50` |

Price suffixes: **VB/VHB** = Verhandlungsbasis (negotiable), **FP** = Festpreis (fixed price)

### German Date Parsing

Handles multiple formats:

| Input | Output (ISO) |
|-------|-------------|
| `31.03.2026` | `2026-03-31` |
| `12/2025` | `2025-12-01` |
| `April 2026` | `2026-04-01` |
| `Dez 2025` | `2025-12-01` |

---

## Data Normalization

### Aircraft Listing Mapping

| Source Field | DB Column | Notes |
|-------------|-----------|-------|
| title | `headline`, `headline_de`, `model` | Title used as model approximation |
| year | `year` | Validated: 1900–current+1, skip if 0/null |
| price | `price` | Validated: must be > 0, skip if 0/null |
| description | `description`, `description_de` | Must not be empty after cleaning |
| engine | `engine_type_name` | Free text |
| totalTime | `total_time` | Numeric hours |
| mtow | `max_takeoff_weight` | Stored as text with `_unit: "kg"` |
| annualInspection | `last_annual_inspection` | Only if valid ISO date (YYYY-MM-DD) |
| contactName | `contact_name` | Default: "Siehe Originalanzeige" |
| contactEmail | `contact_email` | Default: "noreply@trade.aero" |
| contactPhone | `contact_phone` | Default: "" |
| location | `location` | Default: "Deutschland" |
| — | `registration` | "N/A" (not available in source) |
| — | `serial_number` | "N/A" (not available in source) |
| — | `status` | "active" |
| — | `country` | "DE" |
| — | `currency` | "EUR" |
| — | `is_external` | `true` |
| — | `source_name` | "helmuts-ul-seiten.de" |
| — | `source_url` | Dedup key: `pageUrl#index@date` |
| — | `user_id` | System crawler UUID |

### Parts Listing Mapping

| Source Field | DB Column | Notes |
|-------------|-----------|-------|
| title | `headline`, `headline_de` | — |
| category | `category_id` | avionics→1, engines→2, rescue→3, misc→4 |
| title (first word) | `manufacturer` | Brand matching or first-word fallback |
| price | `price` | Nullable (parts can be "price on request") |
| description | `description`, `description_de` | Falls back to title if empty |
| totalTime | `total_time` | Operating hours |
| — | `condition_code` | "AR" (As-Removed) default for used parts |
| — | `ships_internationally` | `true` |

---

## Image Pipeline

### Flow

```
External URL (helmuts-ul-seiten.de/grafik-2/markt/...)
    │
    ▼ Download (fetch with User-Agent, Accept: image/*)
    │
    ▼ Determine format (PNG stays PNG, everything else → JPEG)
    │
    ▼ Upload to Supabase Storage
    │   Bucket: "aircraft-images" or "parts-images"
    │   Path: "listings/{uuid}.jpg"
    │
    ▼ Get public URL
    │   https://<project>.supabase.co/storage/v1/object/public/{bucket}/listings/{uuid}.jpg
    │
    ▼ Store in DB as JSONB: [{"url": "...", "alt": "listing title"}]
```

### Concurrency

- Max 3 parallel uploads per listing (`MAX_CONCURRENT = 3`)
- Uses `Promise.allSettled` — failed uploads don't block others
- Images only uploaded for new listings (updates skip re-upload)

### Next.js Optimization

The TradeAero website uses Next.js `<Image>` component with:
- Auto-conversion to WebP/AVIF based on browser support
- Responsive resizing across 6 device breakpoints (640px–1920px)
- Server-side caching of optimized versions

No image processing needed in the crawler — Next.js handles it at serve time.

---

## Translation Pipeline

### Model & Configuration

- **Model**: `claude-haiku-4-5-20251001` (Claude Haiku 4.5)
- **Temperature**: 0.1 (low for consistency)
- **Max tokens**: 8192
- **Cost**: ~$0.002 per listing (headline + description → 13 target languages)

### System Prompt

```
You are a professional aviation marketplace translator for TradeAero.

Rules:
- Preserve all technical aviation abbreviations: TBO, SMOH, TTAF, IFR, VFR, STOL, MTOW, etc.
- Preserve brand names and model numbers: Cessna, Rotax, Garmin G1000, etc.
- Use formal register per language (Sie-Form, vouvoiement, usted, etc.)
- Keep professional, concise marketing tone
- Detect source language automatically
- Return valid JSON only
```

### Translation Request

Single API call per listing translates headline + description into all 13 non-source languages. Source language (German) is detected automatically.

### Fallback Behavior

If `ANTHROPIC_API_KEY` is not set or translation fails:
- Listing is inserted with German text in all locale columns
- Warning logged, crawl continues
- No listing is skipped due to translation failure

---

## Slug Generation

### Transliteration Support

| Script | Example | Output |
|--------|---------|--------|
| Cyrillic (Russian) | `Продажа самолёта` | `prodazha-samolyota` |
| Greek | `Πώληση αεροσκάφους` | `polisi-aeroskafous` |
| Turkish | `Uçak satışı` | `ucak-satisi` |
| Latin diacritics | `Flugzeug für Verkauf` | `flugzeug-fur-verkauf` |

### Slug Format

```
{transliterated-headline}
```

Max 80 characters, lowercase, alphanumeric + hyphens only.

---

## Database Integration

### Connection

- Uses `@supabase/supabase-js` with **service role key**
- Service role bypasses all Row Level Security policies
- No session persistence (`auth: { persistSession: false }`)

### System User

- Email: `crawler@trade.aero`
- UUID: `f074e36d-a26f-44d8-8929-b23e6a2575e7`
- Created in `auth.users` + `profiles` tables
- Has a random unusable password (no one can log in)
- All scraped listings have `user_id` pointing to this profile
- Existing RLS policies (`auth.uid() = user_id`) prevent real users from editing crawler-owned listings

### Tables Written To

| Table | Operation | Volume |
|-------|-----------|--------|
| `aircraft_listings` | INSERT / UPDATE | ~100 listings per run |
| `parts_listings` | INSERT / UPDATE | ~390 listings per run |
| `crawler_runs` | INSERT + UPDATE | 2 rows per run (1 aircraft + 1 parts) |

### Locale Columns Populated (per listing)

- `headline_{en,de,fr,es,it,pl,cs,sv,nl,pt,ru,tr,el,no}` (14 columns)
- `description_{en,de,fr,es,it,pl,cs,sv,nl,pt,ru,tr,el,no}` (14 columns)
- `slug_{en,de,fr,es,it,pl,cs,sv,nl,pt,ru,tr,el,no}` (14 columns)

---

## Deduplication & Idempotency

### Strategy

Each listing gets a **stable source ID** composed of:
```
{pageUrl}#{listingIndex}@{postedDate}
```

Example: `https://www.helmuts-ul-seiten.de/verkauf1a.html#5@2026-03-31`

This ID is stored in the `source_url` column which has a **unique index** (`WHERE source_url IS NOT NULL`).

### Upsert Logic

```
1. SELECT id FROM table WHERE source_url = ?
2. IF found → UPDATE (text fields, translations, specs — skip images)
3. IF not found → INSERT (full record with images)
```

### Re-run Behavior

- **Existing listings**: Updated with latest translations and metadata
- **New listings**: Inserted with full pipeline (images + translations)
- **Removed listings**: Not deleted (stay active until manually archived)
- **Images**: Only uploaded for new inserts (updates preserve existing images)

---

## Run Monitoring

### `crawler_runs` Table Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `run_id` | text | Unique identifier (`aircraft-{timestamp}`) |
| `source_name` | text | "helmuts-ul-seiten.de" |
| `target` | text | "aircraft" or "parts" |
| `status` | text | "running", "completed", or "failed" |
| `pages_processed` | integer | Number of HTML pages fetched |
| `listings_found` | integer | Total listing blocks parsed |
| `listings_inserted` | integer | New listings created |
| `listings_updated` | integer | Existing listings refreshed |
| `listings_skipped` | integer | Failed validation (no price/year/description) |
| `errors` | integer | DB or network errors |
| `images_uploaded` | integer | Images sent to Supabase Storage |
| `translations_completed` | integer | Listings translated to 14 locales |
| `duration_ms` | integer | Total runtime in milliseconds |
| `error_message` | text | Error details if status = "failed" |
| `warnings` | jsonb | Array of warning messages (max 100) |
| `metadata` | jsonb | `{node_version, github_sha, github_run_id}` |
| `started_at` | timestamptz | Run start time |
| `completed_at` | timestamptz | Run end time |

### Admin Dashboard

The crawler monitoring tab lives at `/dashboard/admin/` → "Crawler" tab in the TradeAero web app. It shows:
- Summary cards: total runs, listings ingested, images uploaded, translations
- Run history with status badges (green/red/blue), detailed stats per run
- Error messages and warnings inline
- Filter by status and target, CSV export, pagination

---

## Error Handling & Validation

### Pre-Insert Validation (aircraft)

Listings are **skipped** (not inserted) if:
- `price` is null, 0, or negative → `aircraft_listings_price_check` constraint
- `year` is null, 0, < 1900, or > current year + 1 → `aircraft_listings_year_check` constraint
- `description` is empty after cleaning → `aircraft_listings_description_check` constraint

### Date Validation

`last_annual_inspection` is only set if the parsed value is a valid ISO date (`YYYY-MM-DD`). Invalid formats like `"12/2025"` are parsed into `"2025-12-01"` by `parseGermanDate()`. Completely unparseable dates are set to `null`.

### Network Errors

- HTTP fetches retry 3 times with exponential backoff (2s, 4s)
- Individual listing failures don't stop the crawl (logged and counted)
- Fatal errors (e.g., Supabase unreachable) fail the entire run

### Image Upload Errors

- Failed downloads/uploads are logged as warnings
- Listing is inserted without the failed image
- `Promise.allSettled` ensures one bad image doesn't block others

### Translation Errors

- If API key is missing, all translations are skipped (German only)
- Individual translation failures fall back to German text for all locales
- Crawl continues regardless of translation errors

---

## GitHub Actions Workflow

### Schedule

- **Cron**: `0 6 * * *` (daily at 06:00 UTC)
- **Manual**: workflow_dispatch with target selector (all/aircraft/parts)

### Workflow Steps

1. Checkout repository
2. Setup Node.js 20 with npm cache
3. `npm ci` (install dependencies)
4. `npm run build` (compile TypeScript)
5. `node dist/index.js --target ${{ target }}` with environment secrets

### Timeout

30 minutes (accounts for image uploads + translation API calls).

### Environment

Runs on `ubuntu-latest` GitHub-hosted runners with dynamic/rotating IP addresses.

---

## Adding New Sources

To add a new website to crawl:

### 1. Add Source Config

In `src/config.ts`:
```typescript
sources: {
  helmut: { /* existing */ },
  newSource: {
    name: "new-source.com",
    baseUrl: "https://www.new-source.com",
    aircraft: ["https://www.new-source.com/listings.html"],
    parts: [],
  },
},
```

### 2. Create Parser

In `src/parsers/new-source.ts`:
```typescript
export function parseNewSourcePage(
  html: string,
  pageUrl: string,
  sourceName: string
): ParsedAircraftListing[] {
  // Analyze HTML structure and implement extraction logic
}
```

### 3. Create Crawler

In `src/crawlers/new-source-crawler.ts`:
- Follow the pattern in `aircraft-crawler.ts`
- Use `startCrawlRun()` / `completeCrawlRun()` for monitoring
- Reuse existing `upsertAircraftListing` / `upsertPartsListing` for DB writes

### 4. Register in Entry Point

In `src/index.ts`, add the new target option and call the new crawler.

### 5. Consider Proxy

For sources that may rate-limit or block GitHub Actions IPs, consider integrating a residential proxy service (e.g., Bright Data). See the proxy integration section in the main repo documentation.

---

## Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `aircraft_listings_price_check` | Listing has no parseable price | Expected — listing is skipped |
| `aircraft_listings_year_check` | No "Baujahr" field found | Expected — listing is skipped |
| `aircraft_listings_description_check` | Description empty after cleaning | Check parser `extractDescription` logic |
| `invalid input syntax for type date` | Bad date format in `last_annual_inspection` | Should be caught by `isValidIsoDate` check |
| `duplicate key value violates unique constraint` | Race condition on concurrent upsert | Rare — retry resolves it |
| Translation returns `null` | API key missing or rate limit hit | Check ANTHROPIC_API_KEY secret |
| Images not appearing | Bucket doesn't exist or isn't public | Create bucket in Supabase Storage UI |
| `System user not found` | crawler@trade.aero profile missing | Run setup SQL from the guide |

### Useful Queries

```sql
-- Count external listings
SELECT COUNT(*) FROM aircraft_listings WHERE is_external = true;
SELECT COUNT(*) FROM parts_listings WHERE is_external = true;

-- Latest crawler runs
SELECT status, target, listings_inserted, listings_updated, listings_skipped, errors, duration_ms, started_at
FROM crawler_runs ORDER BY started_at DESC LIMIT 10;

-- Check translations populated
SELECT id, headline_en, headline_fr, headline_es
FROM aircraft_listings WHERE is_external = true LIMIT 5;

-- Check images stored locally
SELECT id, headline, images
FROM aircraft_listings WHERE is_external = true AND jsonb_array_length(images) > 0 LIMIT 5;

-- Find listings without translations
SELECT id, headline FROM aircraft_listings
WHERE is_external = true AND headline_en IS NULL;
```
