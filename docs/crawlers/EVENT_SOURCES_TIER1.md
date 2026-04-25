# Event Crawlers — Tier-1 Source Plan

> **Status (2026-04-25):** Tracking doc. Companion to `VEREINSFLIEGER_CONCEPT.md`
> and `ICS_FEED_CONCEPT.md`.

---

## 1. Why Tier 1 first

Aviation events are a content moat — without inventory the section is
empty and nothing else (map view, "near me" filter, SEO landing pages,
translation pipeline) matters. This doc tracks the eleven sources
called out in the events-section enhancement brief, with a recommended
ingestion approach, canonical URL, and current status for each.

Two reusable building blocks underpin the plan:

1. **`runEventCrawler` helper** (`src/crawlers/run-event-crawler.ts`).
   Captures the orchestrator boilerplate (start run / fetch / upsert /
   complete run) so a bespoke HTML crawler is a parser file plus a
   ~25-line crawler shim. Used today by both
   `vereinsflieger-crawler.ts` and `ics-crawler.ts`.
2. **Generic ICS crawler**
   (`src/crawlers/ics-crawler.ts` + `config.sources.ics.calendars[]`).
   Any source that publishes a public iCalendar feed becomes a single
   config-line addition, no parser required. See
   `ICS_FEED_CONCEPT.md` for the vetting checklist.
3. **Nominatim geocoder** (`src/utils/geocode.ts`). Runs inside
   `upsertEvent` for every new row whose parser didn't already set
   `latitude`/`longitude`. Free, 1 req/s, soft-fail. Drives the
   future map view + "events near me" filter.

---

## 2. Source matrix

Approach legend:

- **ICS** — add to `config.sources.ics.calendars[]` after vetting.
  Effort: minutes per feed.
- **HTML** — clone Vereinsflieger pattern: write a cheerio parser,
  add a config entry, ship a `crawl-<source>.yml` workflow. Effort:
  ~1 day per source.
- **HYBRID** — root org publishes a calendar (ICS or feed), but each
  chapter / sub-org has its own page. Combine the two.

| # | Org | Coverage | Approach | Canonical URL | Status |
|---|---|---|---|---|---|
| 1 | EAA chapter calendars | US (≈900 chapters) | HYBRID — EAA chapters use a shared event-management platform with per-chapter ICS export. Bulk-collect ICS URLs from the chapter directory, then ingest via the generic ICS crawler. | https://www.eaa.org/eaa/eaa-chapters | Planned |
| 2 | AOPA chapter calendars | US (≈90 regional + 50 university chapters) | HYBRID — AOPA Pilot Information Center publishes a national calendar and chapter-specific events. Investigate whether the chapter calendar is exposed as ICS; otherwise HTML scrape. | https://www.aopa.org/community/events | Planned |
| 3 | FAI / CIVA | Aerobatics + airsports (worldwide) | HTML — FAI publishes the international competition calendar as structured HTML. CIVA runs the aerobatics sub-calendar. | https://www.fai.org/calendar https://www.fai.org/commission/civa | Planned |
| 4 | NBAA | Business aviation (US-based, global events) | HTML — single curated event list at `nbaa.org/events`. Few high-value events per year (BACE, Schedulers & Dispatchers Conf, Leadership Conf). | https://nbaa.org/events/ | Planned |
| 5 | EBACE | Business aviation (Europe, annual) | HTML — single annual fair (Geneva). Detail page provides date / venue / sessions; one-shot scrape per year is sufficient. | https://www.ebace.aero/ | Planned |
| 6 | AERO Friedrichshafen | GA trade fair (Germany, annual) | HTML — single annual fair page. Static date / venue / sub-events; minimal scrape. | https://www.aero-expo.com/ | Planned |
| 7 | Eurocontrol | Civil ATM / aviation policy events (Europe) | HTML — events index at `eurocontrol.int/events`. Modern CMS, structured listing. | https://www.eurocontrol.int/events | Planned |
| 8 | BBR (Bundeskommission Segelflug) | Gliders (Germany) | HTML — DAeC's gliding commission publishes the German glider competition calendar. Page is server-rendered HTML. | https://www.daec.de/sportarten/segelflug/ | Planned |
| 9 | DULV | Ultralights (Germany) | HTML — Deutscher Ultraleichtflugverband's events page lists fly-ins, training events, and member meetups. Cleanest German UL feed outside Vereinsflieger. | https://www.dulv.de/ | Planned |
| 10 | French FFA | Pilot association (France) | HTML — Fédération Française Aéronautique publishes a national event calendar. Source language `fr` — bilingual-min translator covers EN automatically. | https://www.ff-aero.fr/ | Planned |
| 11 | UK GASCo | General aviation safety (UK) | HTML — General Aviation Safety Council publishes a small calendar of safety evenings + AGM. Source language `en` — no translation work. | https://www.gasco.org.uk/ | Planned |

> **URL caveat:** every URL above is the canonical _organisation_ home
> page. The exact events sub-path needs verification via `curl` /
> browser before a crawler is wired up — sites change their URL schema
> on redesigns. The vetting steps in §3 cover this.

---

## 3. Workflow per new source

For an HTML source — the "1-day clone" path:

1. **Pre-flight (15 min).**
   - `curl -I` the candidate events URL. Confirm 200, no Cloudflare,
     no auth.
   - Check `/robots.txt` for disallow rules.
   - Skim the page DOM in the browser — verify events render in HTML
     (not JS-only).
   - Confirm ToS allows crawling (see
     `tradeaero-refactor/docs/EXTERNAL_SOURCE_TOS_AUDIT.md`).
2. **Parser (3–4 hr).** Add `src/parsers/<source>.ts` with one
   exported `parse<Source>Page(html, pageUrl, sourceName) =>
   ParsedEvent[]`. Reuse `cleanText`, `parseGermanDateRange` (or its
   locale-equivalent), and `extractIcaoFromVenue` from existing
   parsers where possible.
3. **Crawler (15 min).** Add `src/crawlers/<source>-crawler.ts` —
   mirror `vereinsflieger-crawler.ts`. Should be ~25 lines now that
   the orchestrator lives in `runEventCrawler`.
4. **Config (5 min).** Add a `<source>` entry to `config.sources` in
   `src/config.ts` with `events: [...]`. Wire the source into the
   `Source` union in `src/index.ts` and add a switch case.
5. **Workflow (10 min).** Copy `.github/workflows/crawl-vereinsflieger.yml`
   to `.github/workflows/crawl-<source>.yml`. Pick a cron slot at
   least 30 min off any existing event-crawler slot to avoid
   piling on the events DB.
6. **Admin wiring (refactor side, 10 min).** Append the source to:
   - `src/components/dashboard/admin/AdminCrawlerTab.tsx` — Events
     trigger group + `getSourceCategory` classifier.
   - `src/app/api/admin/trigger-crawl/route.ts` — `WORKFLOW_MAP` and
     the `source === "all"` fan-out list.
7. **Test.** `pnpm tsx src/index.ts --source <source> --target events`
   against staging. Open `/events` after the run — events from the
   source appear with translated EN copy.
8. **Add a vitest spec** that exercises the parser against a
   captured fixture (`src/__tests__/<source>.test.ts`).

For an ICS source:

0. **Discover the candidate feed URL.** Run:

   ```bash
   npm run seed:ics-calendars                  # all 11 Tier-1 orgs
   npm run seed:ics-calendars -- --url=<url>   # a single one-off org
   npm run seed:ics-calendars -- --json        # machine-readable
   ```

   The script visits each canonical events / calendar page and
   prints any `.ics`, `.ical`, `webcal://`, or
   `<link rel="alternate" type="text/calendar">` reference it
   finds, formatted as a ready-to-paste `IcsCalendar` entry. Orgs
   with no exposed feed are listed under a "needs bespoke HTML
   crawler" section so you know to escalate to the HTML path.
1. Confirm the feed URL is stable (no per-session token) and
   public-facing (linked from a "Calendar" page).
2. Check the host's `robots.txt` doesn't disallow the `.ics` path.
3. Append the printed `{ name, url, country, defaultCategory,
   sourceLocale, organiserName, timezone }` object to
   `config.sources.ics.calendars[]`. Edit `country` /
   `defaultCategory` / `sourceLocale` if the seed-script defaults
   need refining.
4. The next scheduled `crawl-ics.yml` run will ingest it. No code
   changes needed.

---

## 4. Open questions

- **EAA chapter ICS bulk discovery.** The 900-chapter directory is
  the highest-leverage single move on inventory. We need a one-shot
  script that scrapes the chapter listing + each chapter's "Events"
  link to extract its ICS URL, then dumps them into the config. Can
  ship as `src/scripts/seed-eaa-chapter-ics.ts` and run once per
  quarter.
- **Recurring-event handling.** ICS crawler currently does not
  expand RRULEs (see `ICS_FEED_CONCEPT.md` §8). Some chapter
  calendars use them for monthly meetings. Decide whether to add
  the `rrule` package + expansion (~6 months of horizon) or leave
  recurring events as one row at first occurrence.
- **Per-source ToS coverage.** The existing
  `EXTERNAL_SOURCE_TOS_AUDIT.md` covers Helmut/Aircraft24/Aeromarkt
  only. Add a row per Tier-1 source as it's vetted.

---

## 5. Tracking

Update the **Status** column of the matrix in §2 as each source moves
through the pipeline:

- `Planned` — listed but no work started.
- `Vetting` — pre-flight in progress (URLs / ToS / DOM shape).
- `Scaffolded` — config + crawler shim in place; parser stub
  returns `[]` until DOM selectors are written.
- `Shipped` — parser complete, workflow scheduled, admin wiring
  done, first successful run logged in `crawler_runs`.
