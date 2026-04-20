# TradeAero Crawler

External aviation marketplace crawler for [TradeAero](https://refactor.trade.aero). Scrapes aircraft and parts listings from multiple German-language sources and ingests them into the TradeAero Supabase database with full multi-language support.

## Sources

| Source | Type | Proxy | Schedule |
|--------|------|-------|----------|
| [Helmut's UL Seiten](https://www.helmuts-ul-seiten.de) | Ultralight / Microlight | No | Daily 06:00 UTC |
| [Aircraft24.de](https://www.aircraft24.de) | All aircraft types | Bright Data | Daily 07:00 UTC |
| [Aeromarkt.net](https://www.aeromarkt.net) | General aviation | Bright Data | Daily 08:00 UTC |

## Features

- **3 independent crawlers** with source-specific HTML parsers and GitHub Actions workflows
- **14-language translation** via Claude Haiku 4.5 (en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no)
- **Image re-hosting** to Supabase Storage with domain allowlist, magic byte validation, and per-locale alt text
- **Reference spec enrichment** -- fills missing performance data from a curated database of 475 aircraft models
- **15 aircraft categories** including Glider and Microlight/Flex-Wing, with engine-based detection (Rotax -> LSA, Lycoming/Continental -> SEP)
- **Bright Data proxy** support (per-source configurable) for sites with anti-bot protection
- **Manufacturer auto-creation** from DB, reference specs table, and 100+ known manufacturer names
- **Confidence-based publishing** -- low confidence matches saved as draft for admin review
- **Robust description validation** -- strips HTML, requires 10+ chars, generates "Title — Year" fallback, skips if still too short
- **Graceful constraint handling** -- DB constraint violations downgraded to warnings; listings skipped without aborting the run
- **Idempotent upserts** -- safe to re-run without creating duplicates
- **Cost tracking** -- proxy bandwidth and translation token usage per run
- **Security hardened** -- HTML tag stripping, SSRF prevention, image validation, 10MB size limits, 30s timeouts, LLM output sanitization
- **Anonymous crawling** -- Chrome 131 User-Agent, browser-like Sec-Fetch headers, no referrer
- **Admin dashboard** monitoring with trigger buttons, source health cards, cost tracking, and error panels
- **107 unit tests** across 4 test files

## Quick Start

```bash
npm install
npm run build

# Crawl a specific source
npm run crawl:helmut
npm run crawl:aircraft24
npm run crawl:aeromarkt

# Crawl all sources sequentially
npm run crawl:all

# Run tests
npm test

# Seed reference performance specs (475 aircraft models)
npm run seed:reference-specs
```

## CLI

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
| `ANTHROPIC_API_KEY` | No | Claude Haiku 4.5 API key for translation |
| `BRIGHT_DATA_PROXY_URL` | No | Bright Data proxy URL |
| `CRAWLER_SYSTEM_USER_ID` | No | UUID of crawler profile |
| `CRAWLER_USER_AGENT` | No | HTTP User-Agent (default: Chrome 131 browser string) |
| `CRAWL_DELAY_MS` | No | Delay between requests in ms (default: 2000) |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |

## GitHub Actions Workflows

4 workflows in `.github/workflows/`:

| Workflow | Schedule | Proxy | Description |
|----------|----------|-------|-------------|
| `crawl-helmut.yml` | Daily 06:00 UTC | No | Helmut's UL Seiten (aircraft + parts) |
| `crawl-aircraft24.yml` | Daily 07:00 UTC | Yes | Aircraft24.de (aircraft only) |
| `crawl-aeromarkt.yml` | Daily 08:00 UTC | Yes | Aeromarkt.net (aircraft + parts) |
| `seed-reference-specs.yml` | Manual only | No | Seed 475 aircraft reference specs |

All workflows support `workflow_dispatch` with target selector and can be triggered from the admin dashboard.

## Setup

### Required GitHub Actions Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key |
| `CRAWLER_SYSTEM_USER_ID` | System user UUID |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `BRIGHT_DATA_PROXY_URL` | Bright Data proxy URL |

### SQL Migrations

Run in order in Supabase SQL Editor:

1. `supabase/add_external_source_columns.sql`
2. `supabase/add_crawler_runs_table.sql`
3. `supabase/add_cost_tracking_columns.sql`
4. `supabase/add_aircraft_reference_specs.sql`
5. `supabase/fix_reference_specs_categories.sql`
6. `supabase/add_source_url_unique_index.sql`

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** -- Codebase reference (tech stack, structure, commands, config, security)
- **[docs/CRAWLER.md](./docs/CRAWLER.md)** -- Architecture & operations guide (parsing strategies, data flow, enrichment, troubleshooting)
