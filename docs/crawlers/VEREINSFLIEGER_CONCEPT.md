# Concept: Vereinsflieger Public-Calendar Event Crawler

> Companion source for `docs/AVIATION_EVENTS_JOBS_CONCEPT.md` (referenced from
> `supabase/migrations/20260506_add_aviation_events.sql` in `tradeaero-refactor`).

> **Status (2026-04-24):** Crawler **shipped**. `src/crawlers/vereinsflieger-crawler.ts`
> + `src/parsers/vereinsflieger.ts` + `src/db/events.ts` are live on the main
> branch; the daily cron (`.github/workflows/crawl-vereinsflieger.yml`, 09:00
> UTC) and admin on-demand trigger (via the refactor repo's crawler tab) both
> run against `tradeaero-dev` on `CRAWLER_ENABLED=true`. SQL migrations —
> `20260424_vereinsflieger_event_support.sql`,
> `20260506_add_aviation_events.sql`,
> `20260510_add_aviation_events_moderation.sql`, and
> `20260511_aviation_events_crawler_dedup.sql` — are applied in
> `tradeaero-refactor`. Crawled rows land with
> `moderation_status='approved'` so they appear on `/events` immediately.

---

## 1. Context

The `aviation_events` table (migrated 2026-05-06) is live but empty — the
events section currently has no inbound feed. `vereinsflieger.de` operates
the largest public aviation-event calendar in the German-speaking world
(seminars, gliding competitions, flying camps, airfield festivals, trade
fairs, general events) and exposes it without authentication at
`https://vereinsflieger.de/publiccalendar/?category={1..6}`.

The `vereinsflieger` crawler:
- pulls every upcoming event across the six source categories,
- maps them onto the existing `event_categories` lookup,
- upserts into `aviation_events` using the same translation / slug / RLS
  pipeline that `aircraft_listings` uses,
- is triggerable from the **Crawler tab** in the admin dashboard exactly
  like the three existing crawlers (Helmut, Aircraft24, Aeromarkt).

This fills the events page in production with ~400–600 DACH events at day
one and is the upstream feed for the user-facing surface described in
§9 below.

---

## 2. Source analysis (vereinsflieger.de/publiccalendar)

Verified by `curl` against the live site on 2026-04-24.

| Aspect | Finding |
|---|---|
| Rendering | Server-rendered HTML (~100 KB / category). No JS needed. |
| Server | `nginx`. No Cloudflare, no captcha, no bot-detection headers. |
| Cookies | Sets `PHPSESSID`; not required for subsequent requests. |
| robots.txt | Empty body — no disallow rules. |
| Auth | None. Public read. |
| Pagination | None. Each category page renders ~16 months of upcoming events in a single response. |
| Detail pages | None. The list is the only surface; only an opaque organizer-redirect token is exposed per row. |
| Volume | 115 events on category=1 alone; ~400–600 across all six categories. |
| Languages | German only on source. |

### 2.1 Category mapping

The `<select id="publiccalendarcategory">` lists IDs 0–6:

| Source ID | Source label | Maps to `event_categories.code` |
|---|---|---|
| 1 | Seminar | `seminar` |
| 2 | Wettbewerb | `competition` |
| 3 | Fliegerlager | `flying-camp` |
| 4 | Flugplatzfest | `airfield-festival` |
| 5 | Ausstellung/Messe | `trade-fair` |
| 6 | Veranstaltungen | **`general`** (new code added by this concept) |

`?category=0` ("Alle Kategorien") is **not** crawled — it would return
duplicates of the per-category pages.

### 2.2 Event row structure

Every event is a `<tr>` inside a single `<table style="max-width:100%">`.
Month section headers are `<tr><td colspan="2" style="...background-color:#eee">April 2026</td></tr>`.
Each event row contains:

```html
<div class="block"><span class="day">24.</span><span class="month">Apr</span></div>
<div class="pubcal_title">Podiumsdiskussion -FIS - Deutschland-Österreich - Schweiz</div>
<div class="pubcal_daterange icon-clock">24.04.2026</div>
<div class="pubcal_daterange icon-info">Seminar - Fortbildung</div>
<div class="pubcal_location">
  <a class="icon-location" href="https://www.google.de/maps/dir/Podium Ost">Podium Ost</a>
</div>
<div class="pubcal_cidname icon-home redirectto" data="/publiccalendar/redirectto…">
  Luftsportverband Rheinland-Pfalz e.V.
</div>
```

Date range formats: `DD.MM.YYYY` (single day) or `DD.MM.YYYY - DD.MM.YYYY`
(multi-day). Times are not exposed.

---

## 3. Bright Data proxy assessment

**Decision: do NOT use Bright Data for this source. Set `useProxy: false`.**

Evidence:
- `nginx` upstream — no Cloudflare / Akamai / hCaptcha / reCAPTCHA / Datadome.
- Plain `Mozilla/5.0` UA returned `200 OK` immediately, no challenge.
- No rate-limit response headers (`X-RateLimit-*`, `Retry-After`).
- Total request volume per crawl run: **6 GETs** (one per category). One run/day = 180 requests/month — well below any plausible threshold.
- Empty `robots.txt`; the calendar is explicitly built for public consumption.

Mitigation if behaviour changes later:
- Flip `config.sources.vereinsflieger.useProxy` to `true` — the existing
  `fetchPage(url, { proxy: src.useProxy })` plumbing in `src/utils/fetch.ts`
  routes through Bright Data automatically when `BRIGHT_DATA_PROXY_URL` is
  set. No code change required beyond the config flag.

This keeps proxy spend at €0 for this crawler and matches the pattern
already used by `helmut`.

---

## 4. Data model fit

`aviation_events` (and `event_categories`) already exist with a 14-locale
schema mirroring `aircraft_listings`. Mapping per row:

| `aviation_events` column | Source | Notes |
|---|---|---|
| `title` | `.pubcal_title` text | Raw German source text. |
| `description` | **synthesized** | `"{subtitle} – {date_range_human} – {venue} – {organizer}"`. Source has no description field. |
| `category_id` | URL `?category=N` | Looked up against the new `general` row for N=6. |
| `start_date` / `end_date` | `.pubcal_daterange.icon-clock` | Parsed `DD.MM.YYYY` / range; midnight Europe/Berlin. End == start for single-day. |
| `timezone` | const | `'Europe/Berlin'` |
| `country` | const | `'DE'` (vereinsflieger is the DACH platform; non-DE venues are rare and still treated as DE-organizer events). |
| `city` | parsed | Best-effort extraction from venue text after stripping ICAO. Falls back to `venue_name`. |
| `venue_name` | `.pubcal_location > a` text | Strip trailing `(EDXX)`. |
| `icao_code` | regex `/\(([A-Z]{4})\)/` on venue text | Nullable. |
| `latitude` / `longitude` | NULL | Not exposed. Future enhancement: nominatim lookup. |
| `organizer_name` | `.pubcal_cidname` text | German club / Verband name. |
| `organizer_website` / `_email` / `_phone` | NULL | Only an opaque redirect token is exposed. |
| `price` / `is_free` | const | `0` / `true` (calendar items are info-only). |
| `requires_registration` | `false` | Not knowable from source. |
| `images` | `'[]'::jsonb` | Source has no images. |
| `external_source` | const | `'vereinsflieger.de'` |
| `source_url` | synthesized | `https://vereinsflieger.de/publiccalendar/?category={N}#{sha1(title|start_date|organizer)}` — see §5.3. |
| `slug` + `slug_{locale}` | generated | Reuse `src/utils/slug.ts` as in `aircraft_listings`. |
| `status` | const | `'active'` (all crawled events are upcoming). |

### 4.1 Schema additions

One small migration in `tradeaero-refactor/supabase/migrations/`:

```sql
-- 20260424_vereinsflieger_event_support.sql
INSERT INTO public.event_categories (code, label, sort_order)
VALUES ('general', 'General event', 100)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

CREATE UNIQUE INDEX IF NOT EXISTS aviation_events_external_source_url_uniq
  ON public.aviation_events (external_source, source_url)
  WHERE external_source IS NOT NULL;
```

The unique index turns `(external_source, source_url)` into the dedup key
the upsert relies on (see §5.3).

---

## 5. Implementation in `tradeaero-crawler`

Branch: `claude/event-crawler-vereinsflieger-6wDfy`.

### 5.1 New / changed files

| File | Action | Purpose |
|---|---|---|
| `src/config.ts` | edit | Add `vereinsflieger` source entry. |
| `src/types.ts` | edit | Add `ParsedEvent` interface. |
| `src/parsers/vereinsflieger.ts` | new | Parse calendar HTML → `ParsedEvent[]`. |
| `src/parsers/shared.ts` | edit (small) | Add `parseGermanDateRange` + `extractIcaoFromVenue` helpers (or inline if only used here). |
| `src/crawlers/vereinsflieger-crawler.ts` | new | Orchestrator: loop categories → fetch → parse → upsert. |
| `src/db/events.ts` | new | `upsertEvent(parsed, systemUserId)` — mirrors `src/db/aircraft.ts`. |
| `src/db/categories.ts` | new (small) | `getEventCategoryIdByCode(code)` cached lookup. |
| `src/index.ts` | edit | Add `"vereinsflieger"` to `Source` type and switch. |
| `package.json` | edit | Add `crawl:vereinsflieger` script. |
| `.github/workflows/crawl-vereinsflieger.yml` | new | Cron + `workflow_dispatch`. |
| `src/__tests__/parsers.test.ts` | edit | Add Vereinsflieger fixture + parser tests. |
| `docs/crawlers/VEREINSFLIEGER_CONCEPT.md` | new | This document. |

### 5.2 `config.ts` entry

```ts
vereinsflieger: {
  name: "vereinsflieger.de",
  baseUrl: "https://vereinsflieger.de",
  events: [
    "https://vereinsflieger.de/publiccalendar/?category=1",
    "https://vereinsflieger.de/publiccalendar/?category=2",
    "https://vereinsflieger.de/publiccalendar/?category=3",
    "https://vereinsflieger.de/publiccalendar/?category=4",
    "https://vereinsflieger.de/publiccalendar/?category=5",
    "https://vereinsflieger.de/publiccalendar/?category=6",
  ],
  useProxy: false,
  sendColdEmailInvite: false,
} satisfies SourceConfig,
```

`SourceConfig` gains an optional `events?: string[]` array alongside the
existing `aircraft` / `parts` arrays.

### 5.3 Parser & dedup

`parseVereinsfliegerPage(html, pageUrl, sourceName) -> ParsedEvent[]`:

1. Load with cheerio; `$('table > tbody > tr')`.
2. Walk rows: a row whose `<td>` has `colspan="2"` is a month header — skip
   but remember the month context (used only for sanity checks).
3. For an event row, extract title, date range, subtitle, venue href + text,
   organizer.
4. Parse date range: `^(\d{2})\.(\d{2})\.(\d{4})(?:\s*-\s*(\d{2})\.(\d{2})\.(\d{4}))?$`
   into `start_date` / `end_date` at `00:00 Europe/Berlin`.
5. Synthesize `sourceId = sha1(title + '|' + startISO + '|' + organizer)`
   (16-char prefix is enough — collisions vanishingly improbable across a
   few hundred rows).
6. Build `source_url = ${pageUrl}#${sourceId}` so the unique index in
   §4.1 dedups even when the same event recurs across runs or weeks.

`upsertEvent` flow (mirrors `upsertAircraftListing`):
1. SELECT by `(external_source, source_url)`.
2. Hash `(title || description)`; compare with stored hash to decide if
   re-translation is needed.
3. Resolve `category_id` via the cached `event_categories` lookup.
4. If new or hash changed → translate title + description into 14 locales
   via the existing Claude Haiku helper, regenerate `slug_{locale}`.
5. INSERT or UPDATE atomically.
6. Push run stats to `crawler_runs` (target = `'events'`).

### 5.4 `target` flag

`Target` enum in `src/index.ts` extends from `"aircraft" | "parts" | "all"`
to `"aircraft" | "parts" | "events" | "all"`. The `"all"` case for the
vereinsflieger crawler simply means "all six categories".

### 5.5 Schedule

GitHub Actions cron: **daily 09:00 UTC** (after the three existing crawlers
finish at 06/07/08:00). Calendar data changes slowly, but daily keeps
admin operational expectations consistent and the run is cheap (6 requests).

---

## 6. Admin dashboard wiring (`tradeaero-refactor`)

Branch: `claude/add-event-crawler-1f6mh`.

Three small edits — no new components — all shipped on
`claude/add-event-crawler-1f6mh`:

| File | Change | Status |
|---|---|---|
| `src/components/dashboard/admin/AdminCrawlerTab.tsx` | Appended `{ key: "vereinsflieger", label: "Vereinsflieger" }` to the hardcoded button array. Added `if (name.includes("vereinsflieger")) return "text-amber-600";` to `getSourceColor()`. Added `"events"` as a target filter option so run history can be filtered to event-only runs. | ✅ shipped |
| `src/app/api/admin/trigger-crawl/route.ts` | Added `vereinsflieger: "crawl-vereinsflieger.yml"` to `WORKFLOW_MAP`, and appended `"vereinsflieger"` to the `source === "all"` fan-out. | ✅ shipped |

The crawler tab auto-populates source filter / health card / run history
rows from `crawler_runs`, so the `vereinsflieger.de` row appears alongside
Helmut/Aircraft24/Aeromarkt as soon as the first run completes. Admin flow:

1. Navigate to `/dashboard/admin/` → **Crawler** tab.
2. Click the **Vereinsflieger** button (or **Crawl All** to fan out to all
   four crawlers).
3. The POST to `/api/admin/trigger-crawl` dispatches
   `crawl-vereinsflieger.yml` via `repository_dispatch`; results appear in
   the run-history table as a `target=events` row within ~60s of
   completion.

---

## 7. Verification

Local (in `tradeaero-crawler`):

```bash
pnpm install
pnpm test -- parsers.test.ts            # new parser fixture must pass
BRIGHT_DATA_PROXY_URL= CRAWLER_ENABLED=true \
  pnpm tsx src/index.ts --source vereinsflieger --target events
```

Confirm:
- 6 category pages fetched, no proxy bytes accounted in `crawler_runs`.
- ≥ ~400 rows discovered across categories.
- Re-running immediately produces 0 inserts, all updates skipped (hash
  unchanged) — proves dedup index works.

Integration (against staging Supabase):
- Migration `20260424_vereinsflieger_event_support.sql` applied.
- Open the events section in `tradeaero-refactor` → events appear with
  German titles + auto-translated locale variants.
- Open admin dashboard → Crawler tab shows a "Vereinsflieger" button next
  to Helmut/Aircraft24/Aeromarkt.
- Click the button → `/api/admin/trigger-crawl` returns
  `{ status: "triggered" }`; GitHub Actions run kicks off; row appears in
  the run history within ~60 s of completion.

End-to-end:
- Wait for the daily cron to fire once and confirm the same row appears
  unprompted.

---

## 8. Out of scope (deliberately deferred)

- Geocoding venue text → lat/long (would require Nominatim and a separate
  enrichment job).
- Following organizer `redirectto` tokens to scrape per-organizer detail
  pages (fragile, per-Verein parsing, large request fan-out).
- Past-event archival — vereinsflieger only exposes upcoming events; we
  rely on `expires_at` housekeeping already provided by the events table.

---

## 9. End-user surface (`tradeaero-refactor`, cross-referenced here)

The crawler is one of four input paths into `aviation_events`. All four
share the same read surface and lifecycle; the only difference is the
`moderation_status` they land with.

| Input | Who | Lands with | Visible on `/events` |
|---|---|---|---|
| Vereinsflieger crawler (this doc) | `crawler@trade.aero` system user, `external_source='vereinsflieger.de'` | `moderation_status='approved'` | Immediately after the run completes |
| Admin-authored event | Admin via `EventForm` | `moderation_status='approved'` | Immediately |
| User-submitted event via `/events/submit/` | Signed-in user (AuthModal-gated in `EventForm`) | `moderation_status='pending'` | **Only after** an admin approves in `AdminEventsTab` |
| Other future crawlers | Respective system users | `moderation_status='approved'` | Immediately |

### 9.1 Browse & bookmarks

- `/events` — public list + filter surface (date-range, category, country,
  list ↔ calendar toggle). RLS policy
  `aviation_events_select_active_public` already enforces
  `status='active' AND moderation_status='approved'`, so pending /
  rejected rows never leak to anonymous readers.
- `/events/[slug]` — detail page with Schema.org `Event` JSON-LD,
  per-event `.ics` download at `/events/[slug]/ics`, bookmark button.
- **Bookmarks** — the polymorphic `bookmarks` table (migration
  `20260509_add_bookmarks_polymorphic.sql`) already supports
  `target_type='event'` with an `event_id` FK to `aviation_events.id`.
  `/bookmarks` renders an **Events** tab alongside Aircraft / Parts /
  Rentals via the existing nested join
  `aviation_events(slug)`. No crawler-side work needed — bookmarking
  works for any row regardless of origin.

### 9.2 User submissions + admin approval

- `/events/submit/` — public URL, anonymous visitors can draft in the
  `EventForm` (state persisted to `localStorage` via
  `useEventFormStore`), but the submit button opens `AuthModal` so an
  account is required to publish. On success the row is written with
  `user_id = auth.uid()`, `status='active'`, and
  `moderation_status='pending'`.
- `AdminEventsTab` (admin dashboard → **Events** tab) is the moderation
  queue: sub-tabs **Pending / Approved / Rejected**, approve+reject
  actions, optional admin notes. Approve flips `moderation_status` to
  `'approved'`, stamps `moderated_at + moderated_by`, kicks off the
  existing publish pipeline (auto-translate → enqueue indexing →
  CacheWarmer), and writes an `admin_activity_logs` row. Reject keeps
  the row as an audit trail but hides it via RLS.
- The moderation queue reuses the same `EventForm` for admin-authored
  events (bypass the queue — admins land direct as `approved`) and for
  edits to already-approved events (translation re-runs only if title
  or description change).

### 9.3 Why the crawler bypasses moderation

Crawled rows originate from the public vereinsflieger calendar — a
curated surface that already performs its own club-level moderation —
and are authored by the `crawler@trade.aero` system user. Forcing them
through `pending` would stall the admin queue (daily ~400–600 rows) and
duplicate work. If spam or low-quality content ever appears, the
per-source allowlist in `src/config.ts` is the right lever, not
per-row review.
