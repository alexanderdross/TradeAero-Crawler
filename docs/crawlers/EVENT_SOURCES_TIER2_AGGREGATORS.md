# Event Crawlers — Tier-2 Aggregator / Publisher Sources

> **Status (2026-04-25):** Planning doc. Companion to
> `EVENT_SOURCES_TIER1.md`, `VEREINSFLIEGER_CONCEPT.md`, and
> `ICS_FEED_CONCEPT.md`. Five new sources surfaced from the
> events-section enhancement brief, all aggregator / magazine /
> forum publishers rather than primary organisations.

---

## 1. Why a separate tier

Tier-1 sources are the *primary organisations* that own their
event inventory (DULV publishes its own training events, EBACE
runs its own fair). Tier-2 sources are *aggregators / publishers
/ media* that re-publish events from many primary organisers:

- A magazine "Termine" page (fliegermagazin) reprints the same
  Tannkosh / AERO Friedrichshafen / fly-in dates that we will also
  ingest from DULV, vereinsflieger, and the airshow's own ICS.
- A forum "Veranstaltungen" board (ulforum) reposts fly-ins that
  the host airfield already announces.
- A flight-school's "Ausflugstipps" curated list (pilotenausbildung)
  recommends the same trade fairs and museum visits that AERO
  Friedrichshafen and the museums themselves list.

Two consequences for the plan:

1. **Cross-source dedup is the long pole.** A naive add-and-ingest
   path will land 3–5 rows per fly-in once these sources go live.
   §4 below specifies the dedup strategy required *before* the first
   Tier-2 crawler ships.
2. **Source priority matters.** When a fly-in is published by both
   the airfield's own ICS and a magazine's reprint, the canonical
   row should come from the primary source — the aggregator row is
   discarded, not stored as a duplicate. §4 specifies the priority
   ordering.

---

## 2. Source matrix

Approach legend matches `EVENT_SOURCES_TIER1.md`:

- **ICS** — config-line addition only (none of the Tier-2 sources qualify).
- **RSS** — WordPress-style `/feed/` endpoint with `pubDate`, `<title>`, `<description>`, `<link>` per item. Light parser.
- **HTML** — bespoke cheerio parser, `~1 day clone` of vereinsflieger.

| # | Publisher | Type | Coverage | Approach | Canonical URL | Bot protection | Proxy needed | Priority¹ | Status |
|---|---|---|---|---|---|---|---|---|---|
| 12 | pilotenausbildung.net | Flight school curation | DE/EU fly-ins, airshows, trade fairs, museums | HTML — three `<table>` blocks under `<h2>` headers (`Luftfahrt Messen`, `Airshows/Flugshows`, `Fly-Inn's und Pilotentreffen`). Museum table is reference data, NOT events — skip. | https://pilotenausbildung.net/ausflugstipps/ | None observed (Apache, no Cloudflare, no captcha) | No | Low (aggregator) | Planned |
| 13 | fliegermagazin.de | Magazine listings | DE/EU fly-ins, airshows | HTML — paginated `/termine/seite/N/`, repeating `<a>` cards with `<h3>` title and `<div class="termine">` label. ~4 pages. | https://www.fliegermagazin.de/termine/ | Cloudflare CDN, but `Allow: /` for `User-agent: *`. AI bots (ClaudeBot, GPTBot, CCBot, …) explicitly disallowed in robots.txt — use the default Chrome-131 UA, do **not** identify as ClaudeBot. | No (try direct first; proxy as fallback if Cloudflare 403s) | Low (aggregator) | Planned |
| 14 | ulforum.de | UL community forum | DE/AT/CH UL fly-ins, pilot meetups | HTML — phpBB-style `Veranstaltungen` board, chronological by month. ~7 events for 2026 visible without login. | https://www.ulforum.de/veranstaltungen | None observed (Apache, sets PHPSESSID cookie). robots.txt returns 404 (no policy); content visible without auth. | No | Mid (community-first source for niche UL events the magazines miss) | Planned |
| 15 | iata.org | Industry association | Worldwide commercial-aviation conferences (IATA AGM, World Cargo Symp., Aviation Energy Forum, …) | HTML — paginated `?page=N#searchForm`, faceted by category + region. Sitecore-style server-rendered cards: `<a>` > `<img>` + `<h4>` + inline date / location. | https://www.iata.org/en/events/ | Cloudflare CDN with `cf-cache-status: HIT` — friendly to crawlers, served from cache. robots.txt blocks `/en/search/`, `/episerver/`, `/utils/` only — events path allowed. | No | High (no overlap with German GA aggregators; expands inventory into commercial / cargo / sustainability events) | Planned |
| 16 | pilot-frank.de | Pilot blog | DE fly-ins, hangar events, training events | RSS — WordPress + The Events Calendar plugin; `/events/feed/` returns RSS 2.0 with one item per event (verified 2026-04-25). `/events/?ical=1` returns HTML (Tribe ICS export disabled), so RSS is the only machine-readable path. | https://pilot-frank.de/events/ (HTML) / https://pilot-frank.de/events/feed/ (RSS) | None observed (Apache, no captcha). robots.txt allows `/`. | No | Low (aggregator; partial overlap with ulforum / fliegermagazin) | Planned |

¹ **Priority** drives the cross-source dedup tie-break in §4: when
the same event appears in multiple sources, we keep the row from
the highest-priority source and discard the rest.

> **URL caveat:** as with Tier-1, every URL above needs a re-check
> via `curl -I` before a crawler is wired up. The pre-flight steps
> in `EVENT_SOURCES_TIER1.md` §3 apply here too.

---

## 3. Bot-protection assessment per source

Captured 2026-04-25 via `curl -sIL` against each canonical URL
using the crawler's default Chrome-131 User-Agent.

| Source | TLS / CDN | robots.txt | First-byte | Cookie required | Recommendation |
|---|---|---|---|---|---|
| pilotenausbildung.net | Apache, HTTP/2 | `Allow: /` (only `/wp-admin/` blocked) | 200 OK in <1s | No | **Direct fetch.** No proxy. |
| fliegermagazin.de | Cloudflare, HTTP/2 (`cf-ray` set, `cf-cache-status: DYNAMIC`) | `Allow: /` for `*`; AI-training bots blocked individually (Amazonbot, Applebot-Extended, Bytespider, CCBot, ClaudeBot, CloudflareBrowserRenderingCrawler, Google-Extended, GPTBot, meta-externalagent). Cloudflare also publishes `Content-Signal: search=yes,ai-train=no` — relevant for AI-training, not for our re-publish use. | 200 OK | No | **Direct fetch with default Chrome-131 UA.** Do NOT advertise as ClaudeBot or any of the listed AI agents. Add `useProxy: true` only if Cloudflare starts 403ing in production (signals: `cf-mitigated: challenge` header). |
| ulforum.de | Apache, HTTP/2 | robots.txt returns 404 (no policy); meta `robots = "index, follow"` on listings | 200 OK; sets `PHPSESSID` cookie (not required for read access) | No | **Direct fetch.** No proxy. Polite delay ≥ 3s — single small site. |
| iata.org | Cloudflare, HTTP/2 (`cf-cache-status: HIT`) | `Allow: /en/events/`; only `/en/search/`, `/episerver/`, `/utils/`, `/en/customers-tax-faq/`, `/en/store/trainings/*` blocked | 200 OK | No | **Direct fetch.** Cache-hit responses suggest IATA actively serves crawlers through Cloudflare's cache — no proxy. |
| pilot-frank.de | Apache, HTTP/2 | `Allow: /` (`Disallow: /wp-admin/`, woocommerce upload paths) | 200 OK on `/events/feed/` returning `<?xml version="1.0" …<rss …>` | No | **Direct fetch of RSS.** No proxy. |

**Rule of thumb for Tier-2:** none of these five sources currently
require Bright Data residential proxy. Two (fliegermagazin,
iata) sit behind Cloudflare but are configured to allow human +
search-engine traffic; we should ship with `useProxy: false` and
flip to `true` only on observed mitigation in `crawler_runs.error`.

> **AI-bot identifier hygiene:** several sources (fliegermagazin
> notably) explicitly `Disallow: /` for `ClaudeBot`, `GPTBot`,
> `CCBot`, etc. Our `CRAWLER_USER_AGENT` env var defaults to a
> plain Chrome browser string (`config.crawler.userAgent`); do NOT
> change it to identify as Claude or any AI training bot for these
> sources. The TOS-audit row in `EXTERNAL_SOURCE_TOS_AUDIT.md`
> §R–§V (one per new source) records each site's stance.

---

## 4. Cross-source duplicate prevention

### 4.1 The problem

The existing dedup index — partial UNIQUE on
`(external_source, source_url)` — only catches *intra-source*
duplicates (same source crawling the same listing twice). It does
**not** catch the dominant Tier-2 failure mode:

> The "Tannkosh 2026 Fly-In" appears as a row from
> `vereinsflieger.de`, another from `ulforum.de`, another from
> `fliegermagazin.de`, and a fourth from `pilotenausbildung.net`.

Without cross-source dedup, the events page shows four cards for
the same fly-in, each linking back to a different aggregator. SEO
landing pages duplicate; the "near me" filter shows ghost density.

### 4.2 The dedup key

For each `ParsedEvent` we compute a stable **canonical key**:

```
canonical_key = sha1(
  start_date_yyyymmdd
  + "|" + (icao_code ?? slugify(city ?? venue_name))
  + "|" + slugify(stripDiacritics(title)).slice(0, 40)
)
```

- **`start_date_yyyymmdd`** — date only, ignores time. Multi-day
  events use the `start_date`. Events on the same day at the same
  airfield with similar titles are treated as the same event.
- **`icao` || city/venue slug** — most aviation events anchor to
  an airfield. ICAO is the strongest key; city falls back when
  ICAO is missing (museum visits, conferences).
- **Title slug** — first 40 chars of the diacritic-stripped slug.
  Catches "Tannkosh 2026 Fly-In" ≈ "tannkosh-2026-fly-in" across
  sources that may title it differently
  ("Fly-In Tannkosh 2026", "Tannkosh 2026", …).

The key is stored in a new column `aviation_events.canonical_key`
(nullable, BTREE-indexed). Migration:
`tradeaero-refactor/supabase/<date>_event_canonical_key.sql`.

### 4.3 Source priority

When two `ParsedEvent`s share the same `canonical_key`, the row
from the higher-priority source wins. Priority is hard-coded in
the crawler (`src/db/event-source-priority.ts`):

| Tier | Priority | Sources | Rationale |
|---|---|---|---|
| 1 (primary org) | 100 | DULV, FAI, NBAA, EBACE, AERO Friedrichshafen, BBR / DAeC, FFA, GASCo, EAA, AOPA, Eurocontrol | Authoritative — the org running the event |
| 1 (organiser-published feed) | 90 | vereinsflieger (publiccalendar), per-club ICS feeds | Published by the venue / host club |
| 2 (community / specialist forum) | 60 | ulforum | First-hand reposts by attendees / hosts |
| 2 (commercial aggregator) | 40 | iata.org | Authoritative for its niche (commercial aviation) — high priority within scope, low score outside it (scoped via `category_id`) |
| 2 (publisher / magazine) | 20 | fliegermagazin, pilot-frank | Reprints of primary inventory |
| 2 (curated tip list) | 10 | pilotenausbildung | Hand-picked recommendation list |

### 4.4 Upsert flow change

Add to `upsertEvent` (in `src/db/events.ts`) just before the
existing SELECT-by-`(external_source, source_url)`:

1. Compute `canonical_key`.
2. SELECT `external_source, source_url, source_priority` from
   `aviation_events` WHERE `canonical_key = $1`.
3. If a row exists from a **higher** priority source → return
   `{ kind: "skipped", reason: "lower_priority_duplicate" }`. The
   row is dropped silently with a `crawler_runs.warnings++`.
4. If a row exists from a **lower** priority source → DELETE that
   row (or set `superseded_by = <new uuid>`) and proceed with INSERT.
5. If a row exists from the **same** source → fall through to the
   existing `(external_source, source_url)` upsert path.
6. Otherwise → proceed with INSERT.

The new skip reason `lower_priority_duplicate` is appended to
`UpsertSkipReason` in `src/db/events-types.ts` and surfaced in
the admin Crawler tab's drop-rate breakdown so we can see how
many aggregator rows are being suppressed per run.

### 4.5 What the dedup key intentionally misses

- **Recurring weekly meetups** at the same airfield with the same
  title (e.g. "Donnerstagstreffen Bienenfarm") → these get the same
  key for every week's instance. Acceptable: the existing
  recurring-event handling in `ICS_FEED_CONCEPT.md` §8 already
  collapses recurring events to their first occurrence.
- **Events that genuinely move venues** (e.g. AERO Friedrichshafen
  rotates halls; AOPA Fly-In moves between Frederick and other
  airfields). The ICAO + date combination keeps these as distinct
  rows, which is correct.
- **Events that change date but keep same title** (rare; usually a
  cancellation + reschedule). Treated as a new event. Operator can
  manually merge in admin UI if needed.

---

## 5. Workflow per Tier-2 source

Mirrors `EVENT_SOURCES_TIER1.md` §3 with three deltas:

1. **Pre-flight (15 min)** — same checks. Plus: confirm the source
   is NOT in `config.sources.<X>.useProxy = true` until observed
   blocks justify it (§3 above).
2. **Parser (3–4 hr)** — same. Add a unit test that exercises
   `canonical_key` generation against a captured fixture, asserting
   the same key is computed for the same event represented by two
   different sources (use a real ulforum + fliegermagazin pair).
3. **Crawler (15 min)** — same shim as vereinsflieger, calling
   `runEventCrawler`.
4. **Config (5 min)** — same.
5. **Workflow (10 min)** — same. Pick a cron slot ≥ 30 min off
   existing event-crawler slots:
   - `crawl-helmut.yml` — 06:00 UTC
   - `crawl-aircraft24.yml` — 07:00 UTC
   - `crawl-aeromarkt.yml` — 08:00 UTC
   - `crawl-vereinsflieger.yml` — (existing slot)
   - `crawl-ics.yml` — (existing slot)
   - **Tier-2 suggested slots:** 09:30 (pilot-frank), 10:00
     (ulforum), 10:30 (pilotenausbildung), 11:00 (fliegermagazin),
     11:30 (iata) — runs after Tier-1 so Tier-1 rows already
     occupy higher-priority slots when the dedup check fires.
6. **Admin wiring (refactor side, 10 min)** — same.
7. **Test** — same.
8. **Add a vitest spec** — same, plus the cross-source dedup
   assertion called out in step 2.

For an RSS source (pilot-frank specifically):

- Reuse the WordPress / Tribe Events RSS pattern: `<item>` with
  `<title>`, `<link>`, `<pubDate>`, `<description>` HTML stripped,
  optional `<content:encoded>` for full body. Date parsing per
  RFC 2822.
- Skip the `cheerio` parser; use the `rss-parser` package (already
  in the dependency tree per `ICS_FEED_CONCEPT.md`?). If not,
  hand-roll with `xmldom` to avoid a new dep.

---

## 6. Open questions

- **Aggregator backfill window.** Tier-2 sources sometimes list
  events 12+ months out (pilotenausbildung shows 2027 + 2030
  entries). Decide whether to ingest the full horizon or cap at
  +18 months to match the rest of the events pipeline.
- **`canonical_key` migration backfill.** The new column needs
  a one-shot backfill for existing rows. SQL:
  ```sql
  UPDATE aviation_events
     SET canonical_key = encode(
       digest(
         to_char(start_date, 'YYYYMMDD') || '|' ||
         coalesce(icao_code, slugify(coalesce(city, venue_name))) || '|' ||
         left(slugify(unaccent(title)), 40),
         'sha1'
       ), 'hex'
     )
   WHERE canonical_key IS NULL;
  ```
  Run inside the same migration that adds the column.
- **Priority for IATA vs primary commercial-aviation orgs.** IATA
  re-lists ICAO meetings, A4A events, and individual airline
  conferences. If we later add ICAO or A4A as Tier-1 sources, IATA
  drops to Tier-2 priority for those rows. Current matrix treats
  IATA as the de-facto canonical commercial-aviation source until
  that day — revisit when adding ICAO.
- **Cloudflare watchdog.** Add a small alerting hook in
  `crawler-runs.ts`: if a source returns ≥3 consecutive runs with
  a Cloudflare-mitigation header (`cf-mitigated`,
  `cf-chl-bypass`), log to `admin_activity_logs` so we can decide
  whether to flip `useProxy: true`. Cheaper than blanket-routing
  through Bright Data.

---

## 7. Tracking

Update the **Status** column of the matrix in §2 as each source
moves through the pipeline (states identical to Tier-1 §5):

- `Planned` — listed but no work started.
- `Vetting` — pre-flight in progress (URLs / ToS / DOM shape /
  TOS-audit row signed off).
- `Scaffolded` — config + crawler shim in place; parser stub
  returns `[]` until DOM selectors are written.
- `Shipped` — parser complete, workflow scheduled, admin wiring
  done, first successful run logged in `crawler_runs`,
  `canonical_key` migration applied, cross-source dedup verified
  against a real Tier-1 row.
