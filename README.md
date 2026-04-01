# TradeAero Crawler

External aviation marketplace crawler for [TradeAero](https://refactor.trade.aero). Scrapes aircraft and parts listings from multiple sources and ingests them into the TradeAero Supabase database.

## Sources

| Source | Type | Proxy | Schedule |
|--------|------|-------|----------|
| [Helmut's UL Seiten](https://www.helmuts-ul-seiten.de) | Ultralight / Microlight | No | Daily 06:00 UTC |
| [Aircraft24.de](https://www.aircraft24.de) | All aircraft types | Bright Data | Daily 07:00 UTC |
| [Aeromarkt.net](https://www.aeromarkt.net) | General aviation | Bright Data | Daily 08:00 UTC |

## Features

- **Multi-source crawling** with source-specific HTML parsers
- **14-language translation** via Claude Haiku 4.5 (en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no)
- **Image re-hosting** to Supabase Storage (Next.js auto-optimizes to WebP/AVIF)
- **Reference spec enrichment** — fills missing performance data from a curated database of 200+ aircraft models
- **Bright Data proxy** support for sites with anti-bot protection
- **Idempotent upserts** — safe to re-run without creating duplicates
- **Cost tracking** — proxy bandwidth and translation token usage per run
- **Admin dashboard** monitoring at `/dashboard/admin/` → Crawler tab
- **Independent GitHub Actions** workflows per source with manual trigger buttons

## Quick Start

```bash
npm install
npm run build

# Crawl a specific source
npm run crawl:helmut
npm run crawl:aircraft24
npm run crawl:aeromarkt

# Seed reference performance specs (200+ aircraft models)
npm run seed:reference-specs
```

## Setup

See [CLAUDE.md](./CLAUDE.md) for full environment variables, GitHub Actions secrets, and SQL migrations.

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — Codebase reference (tech stack, structure, commands, config)
- **[docs/CRAWLER.md](./docs/CRAWLER.md)** — Architecture & operations guide (parsing strategies, data flow, enrichment, troubleshooting)
