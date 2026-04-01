# TradeAero Crawler - Architecture & Operations Guide

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Multi-Source Crawl Pipeline](#multi-source-crawl-pipeline)
3. [Bright Data Proxy Integration](#bright-data-proxy-integration)
4. [HTML Parsing Strategies](#html-parsing-strategies)
5. [Data Normalization & Mapping](#data-normalization--mapping)
6. [Aircraft Reference Specs Enrichment](#aircraft-reference-specs-enrichment)
7. [Image Pipeline](#image-pipeline)
8. [Translation Pipeline](#translation-pipeline)
9. [Slug Generation](#slug-generation)
10. [Database Integration](#database-integration)
11. [Deduplication & Idempotency](#deduplication--idempotency)
12. [Cost Tracking](#cost-tracking)
13. [Run Monitoring](#run-monitoring)
14. [Error Handling & Validation](#error-handling--validation)
15. [GitHub Actions Workflows](#github-actions-workflows)
16. [Adding New Sources](#adding-new-sources)
17. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    GitHub Actions (3 independent crons)                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────┐    │
│  │ Helmut 06:00 UTC│  │ Aircraft24 07:00│  │ Aeromarkt 08:00 UTC │    │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬───────────┘    │
└───────────┼────────────────────┼───────────────────────┼────────────────┘
            ▼                    ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  src/index.ts — CLI (--source helmut|aircraft24|aeromarkt --target ...) │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Source-specific crawler + parser                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────┐    │
│  │ helmut-crawler   │  │ aircraft24-     │  │ aeromarkt-crawler    │    │
│  │ + helmut-aircraft│  │ crawler +       │  │ + aeromarkt parser   │    │
│  │ + helmut-parts   │  │ aircraft24      │  │                      │    │
│  └────────┬────────┘  │ parser          │  └──────────┬───────────┘    │
│           │           └────────┬────────┘             │                │
└───────────┼────────────────────┼──────────────────────┼────────────────┘
            └────────────────────┼──────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Shared per-listing pipeline:                                           │
│  1. Validate (year, description)                                        │
│  2. Check dedup (source_url unique index)                               │
│  3. Resolve manufacturer (FK lookup from aircraft_manufacturers)        │
│  4. Detect category (LSA, helicopter, turboprop, etc.)                  │
│  5. Download images → Supabase Storage                                  │
│  6. Translate 14 locales → Claude Haiku 4.5                             │
│  7. Generate localized slugs                                            │
│  8. Enrich with reference specs (performance, weights, engine, seats)   │
│  9. Upsert to Supabase                                                  │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  crawler_runs table — stats + proxy bytes + translation tokens          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Multi-Source Crawl Pipeline

Each source has its own crawler and parser but shares the same DB layer, image pipeline, translation engine, and reference spec enrichment.

| Source | Crawler | Parser | Proxy | Pages |
|--------|---------|--------|-------|-------|
| Helmut's UL Seiten | `helmut-crawler.ts` | `helmut-aircraft.ts`, `helmut-parts.ts` | No | 3 aircraft + 1 parts |
| Aircraft24.de | `aircraft24-crawler.ts` | `aircraft24.ts` | Yes | Dynamic (index → model → detail, paginated) |
| Aeromarkt.net | `aeromarkt-crawler.ts` | `aeromarkt.ts` | Yes | 6 aircraft categories + 2 parts categories, paginated |

### Crawler Orchestrator Pattern

Each crawler follows the same lifecycle:
1. **Start run** → insert `running` record in `crawler_runs`
2. **Reset counters** → proxy bytes + translation tokens
3. **Get system user** → lookup `crawler@trade.aero` UUID
4. **Fetch + parse pages** → source-specific logic
5. **Per listing** → shared pipeline (validate → dedup → images → translate → enrich → upsert)
6. **Complete run** → update `crawler_runs` with stats + costs

---

## Bright Data Proxy Integration

### Configuration

Set `BRIGHT_DATA_PROXY_URL` environment variable:
```
http://brd-customer-XXXX-zone-tradeaero_crawler:password@brd.superproxy.io:22225
```

### Per-Source Control

Each source in `config.ts` has a `useProxy` flag:
```typescript
helmut:     { useProxy: false },  // No anti-bot
aircraft24: { useProxy: true },   // Rate limiting
aeromarkt:  { useProxy: true },   // Envoy proxy protection
```

### Proxy Routing

- **HTML page fetches**: Routed through proxy when `useProxy: true`
- **Image downloads**: Direct (no proxy) — images are static files with no anti-bot
- **Byte tracking**: All proxied bytes counted for cost reporting

### Cost

~$8.40/GB for Bright Data residential proxy. Typical run: ~15MB HTML = ~$0.13.

---

## HTML Parsing Strategies

### Helmut's UL Seiten (Unstructured)

The most challenging source — **no CSS classes, no IDs, no semantic markup**.

**Block splitting**: Split HTML by `<hr>` tags and `* * *` separators, filter blocks < 50 chars.

**Field extraction via regex**:

| Field | Pattern | Example |
|-------|---------|---------|
| Date | `\d{2}\.\d{2}\.\d{4}` | `31.03.2026` |
| Year | `Baujahr[:\s]*(\d{4})` | `Baujahr: 2022` |
| Engine | `Motor[:\s]*([^•\n]+)` | `Motor: Rotax 912ULS 100 PS` |
| Hours | `(?:Betriebsstunden\|TT)[:\s]*([\d.,]+)` | `TT: 450` |
| MTOW | `MTOW[:\s]*([\d.,]+)\s*kg` | `MTOW: 472,5 kg` |
| Price | `€\s*([\d.,]+)\s*(VB\|FP)?` | `€12.500,- VB` |
| Email | `mailto:` (hex-decoded) or `[at]` pattern | `name[at]domain.de` |

**Email deobfuscation**: Hex decoding (`%66` → `f`) + `[at]`/`(at)` → `@`

**German price parsing**: `12.500,-` → `12500` (dot = thousands separator)

**German date formats**: `DD.MM.YYYY`, `MM/YYYY`, `April 2026`, `Dez 2025`

### Aircraft24.de (Semi-Structured)

**Three-level navigation**: Category index → model listing → detail page

**Listing format**:
```
[Aircraft Model] [Price]
Bj.: [Year]; TTAF: [Hours]; Standort: [Location]
```

**Pagination**: "Seite 1 von X" with "Weiter" (Next) links

**URL patterns**:
- Index: `/singleprop/index.htm`
- Model: `/singleprop/cessna/172--xm10033.htm`
- Detail: `/singleprop/cessna/172--xi12345.htm`

### Aeromarkt.net (Modern Layout)

**Category-based**: Listings organized by aircraft type and parts category

**Parser strategy**: Try multiple CSS selectors (`.listing-item`, `.ad-item`, `.offer-item`, etc.) until one matches, with fallback to link-based detection.

**Pagination**: Standard "Weiter" / "»" next-page links.

---

## Data Normalization & Mapping

### Aircraft Listing Fields

| Source Field | DB Column | Logic |
|-------------|-----------|-------|
| Title | `headline` | As-is |
| Title → parsed | `model` | Remove date prefix, extract after manufacturer |
| Title → matched | `manufacturer_id` | Dynamic FK lookup from `aircraft_manufacturers` table |
| Title + description | `category_id` | Keyword detection (LSA=11, helicopter=10, turboprop=9, etc.) |
| Year | `year` | Must be 1900–current+1, skip if invalid |
| Price | `price` | NULL if not found (price_negotiable=true) |
| Engine string | `engine_type_name`, `engine_power`, `engine_power_unit` | Parsed: "Rotax 912ULS 100 PS" → type/power/unit |
| — | `fuel_type` | "MOGAS" for Rotax engines |
| — | `seats` | Detected from text or default "2" for ULs |
| — | `condition_id` | 1 (Excellent) if ≤2yr old, 3 (Good) otherwise |
| — | `country` | "Germany" (full English name for `translateCountryName()`) |
| Source name | `contact_name` | "Helmuts UL Seiten" (or source-specific) |
| Source URL | `website` | Link to original listing page |
| Source name | `company` | Source website identifier |

### Performance Data Enrichment

If a field is null after parsing, the reference specs table fills it:
- `cruise_speed` + `cruise_speed_unit`
- `max_speed` + `max_speed_unit`
- `max_range` + `max_range_unit`
- `service_ceiling` + `service_ceiling_unit`
- `performance_climb_rate` + `performance_climb_rate_unit`
- `performance_takeoff_distance` + `performance_takeoff_distance_unit`
- `performance_landing_distance` + `performance_landing_distance_unit`
- `performance_fuel_consumption` + `performance_fuel_consumption_unit`
- `empty_weight` + `empty_weight_unit`
- `max_takeoff_weight` + `max_takeoff_weight_unit`
- `max_payload` + `max_payload_unit`
- `fuel_capacity` + `fuel_capacity_unit`
- `engine_type_name`, `engine_power`, `engine_power_unit`
- `fuel_type`, `seats`

---

## Aircraft Reference Specs Enrichment

### Table: `aircraft_reference_specs`

Pre-populated with performance data for 200+ aircraft models across all categories:

| Category | Example Models |
|----------|---------------|
| UL/LSA | Dynamic WT-9, C42, CT, Virus, P92, Savage Cub, Eurofox, Bristell |
| Single Engine Piston | Cessna 172, Piper Cherokee, Bonanza, SR22, DA40, Mooney M20 |
| Multi Engine Piston | Baron 58, Seneca, Seminole, Cessna 310 |
| Turboprop | TBM 960, PC-12, King Air, Caravan, M600 |
| Light/Mid Jet | Vision Jet, Phenom 300, Citation CJ4, HondaJet |
| Heavy/Ultra Long Range | G650, Global 7500, Falcon 8X |
| Helicopter | R44, H125, Bell 407, AW109 |
| Gyrocopter | Calidus, Cavalon, MTOsport, Magni M16 |
| Experimental | RV-7, RV-10, Lancair Evolution, Glasair, Sonex |

### Seeding

Run via GitHub Actions: **Actions → "Seed Aircraft Reference Specs" → Run workflow**

Uses Claude Haiku 4.5 to generate accurate specs per model. Skips existing entries.

### Lookup Strategy

```
1. Load all reference specs into memory (cached)
2. For each listing, score all entries:
   - +2 for manufacturer match in title
   - +3 for model match in title
   - +1 for variant match in title
3. Best match with score ≥ 3 (at least model) is used
4. Only null/missing fields are filled — never overwrites
```

---

## Image Pipeline

```
External URL (helmuts-ul-seiten.de/grafik-2/markt/...)
    │
    ▼ Download via fetchBinary() (optional proxy)
    │
    ▼ Determine format (PNG stays PNG, else JPEG)
    │
    ▼ Upload to Supabase Storage
    │   Bucket: "aircraft-images" or "parts-images"
    │   Path: "listings/{uuid}.jpg"
    │
    ▼ Store in DB as JSONB: [{"url": "https://...supabase.co/...", "alt": "title"}]
```

- Max 3 concurrent uploads per listing
- Images only uploaded for **new** listings (updates skip re-upload)
- Next.js `<Image>` auto-optimizes to WebP/AVIF at serve time
- External source domains also allowed in `next.config.ts` `remotePatterns` as fallback

---

## Translation Pipeline

- **Model**: `claude-haiku-4-5-20251001`
- **Temperature**: 0.1 (consistency)
- **Max tokens**: 8192
- **Locales**: en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no
- **Cost**: ~$0.002 per listing (headline + description → 13 targets)
- **Token tracking**: Input/output tokens counted per run for cost reporting
- **Fallback**: If API key missing or call fails, German text used for all locales

### Aviation-Aware Translation

System prompt preserves:
- Technical abbreviations (TBO, SMOH, TTAF, IFR, VFR, STOL, MTOW)
- Brand/model names (Cessna, Rotax, Garmin G1000)
- Formal register per language (Sie-Form, vouvoiement, usted, etc.)

---

## Slug Generation

Localized slugs with transliteration:

| Script | Example Input | Slug Output |
|--------|--------------|-------------|
| Latin | "Cessna 172 Skyhawk" | `cessna-172-skyhawk` |
| German | "Flugzeug für Verkauf" | `flugzeug-fur-verkauf` |
| Cyrillic | "Продажа самолёта" | `prodazha-samolyota` |
| Greek | "Πώληση αεροσκάφους" | `polisi-aeroskafous` |
| Turkish | "Uçak satışı" | `ucak-satisi` |

Max 80 characters, lowercase, alphanumeric + hyphens.

---

## Database Integration

### System User

- Email: `crawler@trade.aero`
- UUID: `f074e36d-a26f-44d8-8929-b23e6a2575e7`
- No login possible (random password)
- RLS prevents real users from editing crawler-owned listings

### Tables Written To

| Table | Operation | Volume |
|-------|-----------|--------|
| `aircraft_listings` | INSERT/UPDATE | ~100-400 per Helmut run |
| `parts_listings` | INSERT/UPDATE | ~390 per Helmut run |
| `crawler_runs` | INSERT/UPDATE | 2 rows per source per run |

### Locale Columns Populated (per listing)

42 columns: `headline_{14}` + `description_{14}` + `slug_{14}`

---

## Deduplication & Idempotency

**Source ID format**: `{pageUrl}#{listingIndex}@{postedDate}`

**Unique index**: `source_url` column with `WHERE source_url IS NOT NULL`

**Upsert logic**:
- Found → UPDATE (text, translations, specs — skip images)
- Not found → INSERT (full pipeline with images)
- Removed from source → stays active (manual archival)

---

## Cost Tracking

Tracked per crawl run in `crawler_runs`:

| Metric | Column | Pricing |
|--------|--------|---------|
| Proxy bandwidth | `proxy_bytes_transferred` | $8.40/GB |
| Translation input tokens | `translation_input_tokens` | $0.80/MTok |
| Translation output tokens | `translation_output_tokens` | $4.00/MTok |

### Typical Costs Per Run

| Source | HTML Proxy | Translation | Total |
|--------|-----------|-------------|-------|
| Helmut (no proxy) | $0 | ~$0.80 | ~$0.80 |
| Aircraft24 | ~$0.13 | ~$0.50 | ~$0.63 |
| Aeromarkt | ~$0.10 | ~$0.40 | ~$0.50 |

Monthly estimate (3 daily runs): **~$50-60/month**

---

## Run Monitoring

### `crawler_runs` Table

20+ columns tracking: status, pages, listings (found/inserted/updated/skipped), errors, images, translations, duration, proxy bytes, translation tokens, warnings, metadata (git SHA, GitHub run ID).

### Admin Dashboard

At `/dashboard/admin/` → Crawler tab:
- **Trigger buttons**: Helmut UL, Aircraft24, Aeromarkt, Crawl All
- **Cost cards**: Proxy ($), Translation ($), Total Cost ($)
- **Summary**: Runs, listings, images, translations
- **Run history**: Status badges, per-run cost badge, detailed stats
- **Filters**: Source, status, target
- **CSV export**

---

## Error Handling & Validation

### Pre-Insert Validation

| Check | Action |
|-------|--------|
| Year null/0/out of range | Skip listing |
| Description empty | Skip listing |
| Price null | Insert with `price_negotiable = true` |

### Graceful Failures

- Network errors: 3 retries with exponential backoff
- Image upload fails: listing inserted without that image
- Translation fails: German text used for all locales
- Reference spec not found: fields left null
- Individual listing error: logged, counted, crawl continues

---

## GitHub Actions Workflows

### Daily Cron Schedule (staggered)

| Time (UTC) | Workflow | Source |
|------------|----------|--------|
| 06:00 | `crawl-helmut.yml` | helmuts-ul-seiten.de |
| 07:00 | `crawl-aircraft24.yml` | aircraft24.de |
| 08:00 | `crawl-aeromarkt.yml` | aeromarkt.net |

### Manual Triggers

All workflows support `workflow_dispatch` with target selector. The admin dashboard has trigger buttons that call `/api/admin/trigger-crawl` → GitHub Actions API.

### One-Time Workflows

| Workflow | Purpose |
|----------|---------|
| `seed-reference-specs.yml` | Populate reference specs table via Claude Haiku |

---

## Adding New Sources

### 1. Add Source Config (`src/config.ts`)

```typescript
newSource: {
  name: "new-source.com",
  baseUrl: "https://www.new-source.com",
  aircraft: ["https://..."],
  parts: [],
  useProxy: true,
},
```

### 2. Create Parser (`src/parsers/new-source.ts`)

Analyze HTML structure → implement extraction functions returning `ParsedAircraftListing[]`.

### 3. Create Crawler (`src/crawlers/new-source-crawler.ts`)

Follow `helmut-crawler.ts` pattern: startRun → fetch+parse → upsert → completeRun.

### 4. Register in Entry Point (`src/index.ts`)

Add new source to the switch statement.

### 5. Create Workflow (`.github/workflows/crawl-new-source.yml`)

Copy existing workflow, change name/cron/source argument.

### 6. Update Admin Dashboard

Add trigger button in `AdminCrawlerTab.tsx` and workflow mapping in `/api/admin/trigger-crawl/route.ts`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Images not loading (400) | Domain not in Next.js `remotePatterns` | Add domain to `next.config.ts` |
| "Unknown" manufacturer | Not in `aircraft_manufacturers` table | Add manufacturer or improve title parsing |
| "Unknown" category | `category_id` null | Check `detectCategoryId()` keyword matching |
| Country shows "DE" | `country` set to ISO code | Use full English name "Germany" |
| Engine shows "+ null null" | `engine_power`/`engine_power_unit` null | Check `parseEnginePower()` regex |
| Performance tab empty | No reference specs match | Seed reference-specs or add model |
| Crawl timeout (60min) | Too many listings + translations | Split into smaller batches |
| Proxy errors | `BRIGHT_DATA_PROXY_URL` not set | Add GitHub Actions secret |
| Translation null | `ANTHROPIC_API_KEY` not set | Add GitHub Actions secret |
| `description_check` constraint | Description empty after cleaning | Improve `extractDescription()` |

### Useful SQL Queries

```sql
-- Count external listings by source
SELECT source_name, COUNT(*) FROM aircraft_listings
WHERE is_external = true GROUP BY source_name;

-- Latest crawler runs with costs
SELECT source_name, target, status, listings_inserted, listings_updated,
  proxy_bytes_transferred, translation_input_tokens, duration_ms, started_at
FROM crawler_runs ORDER BY started_at DESC LIMIT 10;

-- Check reference specs coverage
SELECT manufacturer, model, variant, cruise_speed, max_speed, engine_type
FROM aircraft_reference_specs ORDER BY manufacturer, model;

-- Find listings without translations
SELECT id, headline FROM aircraft_listings
WHERE is_external = true AND headline_en IS NULL LIMIT 10;

-- Find listings without reference spec enrichment
SELECT id, headline, cruise_speed, max_speed, empty_weight
FROM aircraft_listings WHERE is_external = true AND cruise_speed IS NULL LIMIT 10;
```
