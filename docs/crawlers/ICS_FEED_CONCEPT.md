# Concept: Generic ICS / iCalendar Event Crawler

> Companion source for `docs/AVIATION_EVENTS_JOBS_CONCEPT.md` in
> `tradeaero-refactor` and a sibling to `VEREINSFLIEGER_CONCEPT.md`.

> **Status (2026-04-25):** Pipeline shipped. Calendar list deliberately
> empty — populate `config.sources.ics.calendars[]` after vetting each
> feed (see §3 below).

---

## 1. Purpose

Vereinsflieger covers DACH club events. To become *the* aviation events
repository we need 10× the inventory, and writing a bespoke crawler per
source doesn't scale. **Most aviation organisations already publish an
iCalendar (`.ics`) feed** — flying clubs, EAA chapters, AOPA chapter
calendars, FAI/CIVA event calendars, university aero clubs, manufacturer
owner meetups. A single generic ICS crawler turns each new feed into a
config-line-only addition.

This concept covers:

1. The RFC 5545 ICS parser (`src/utils/ics.ts`).
2. The crawler orchestrator (`src/crawlers/ics-crawler.ts`).
3. The Nominatim geocoder (`src/utils/geocode.ts`) that fills missing
   `latitude`/`longitude` on every events crawler insert (Vereinsflieger
   and ICS alike).

---

## 2. Pipeline shape

```
config.sources.ics.calendars[]
        ↓                fetch (no proxy, polite UA)
   parseIcsCalendar(icsText, calendar, sourceName)
        ↓                normalise into ParsedEvent[]
   upsertEvent(event)
        ↓                geocode if lat/lng missing
        ↓                bilingual-min translate (source + EN)
   aviation_events INSERT/UPDATE
        ↓
   crawler_runs (one row per crawl, target = "events")
```

### 2.1 Differences from the Vereinsflieger crawler

| Aspect | Vereinsflieger | ICS feed |
|---|---|---|
| Structure | HTML scrape (cheerio) | RFC 5545 text |
| Sources | 6 fixed category URLs | N calendars in config |
| Country | Always DE | Per-calendar |
| Source language | Always de | Per-calendar (`sourceLocale`) |
| Description | Synthesised from metadata | Source `DESCRIPTION:` field |
| Categories | URL `?category=N` | ICS `CATEGORIES:` line + per-calendar default |
| Dedup key | `sha1(title|start|organizer)` | Same |

The dedup key is **identical** so a feed that's also pulled by another
crawler doesn't double-insert (e.g. if a club ever syndicates the same
event into two different calendars).

---

## 3. Vetting checklist before adding a feed

Before adding an entry to `config.sources.ics.calendars[]`:

1. The calendar is meant for public consumption (linked from a
   "Calendar" or "Events" page on the publishing site).
2. The host's `robots.txt` does not disallow the `.ics` path.
3. The feed URL is stable — not a per-session token (`?session=xyz`).
4. The `defaultCategory` lives in `event_categories.code` (`seminar`,
   `competition`, `flying-camp`, `airfield-festival`, `trade-fair`,
   `airshow`, `auction`, `webinar`, `meetup`, `general`).
5. Set `country` to ISO 3166-1 alpha-2 (`DE`, `US`, `GB`, …) — drives
   the country pill on `/events/location/[country]`.
6. Set `sourceLocale` if the feed isn't in English. Bilingual-min
   translation will produce English alongside the source.
7. Set `organiserName` to the publishing org so events without a
   per-event organiser inherit a sensible value.

Example entry (don't add until vetted):

```ts
{
  name: "Flugsportverein Kandel — Calendar",
  url: "https://flugsportverein-kandel.de/events/calendar.ics",
  country: "DE",
  defaultCategory: "general",
  timezone: "Europe/Berlin",
  sourceLocale: "de",
  organiserName: "Flugsportverein Kandel e.V.",
}
```

---

## 4. Geocoder

`src/utils/geocode.ts` wraps the OpenStreetMap Nominatim search
endpoint:

- Free, attribution-only.
- Rate-limited to **1 req/sec** (process-global gate).
- Identifying User-Agent (`TradeAero-Crawler/1.0 (+https://trade.aero;
  ops@trade.aero)`) — Nominatim usage policy mandates this.
- 15s timeout, soft-fail (`null` on error).
- `GEOCODE_DISABLED=true` env var disables it without a redeploy
  (operational kill switch).

The crawler's `upsertEvent` calls `geocode()` only when the row is new
(no existing match) and `latitude`/`longitude` are not already set —
keeps Nominatim load to a minimum and avoids re-geocoding on edit.

### 4.1 Why Nominatim and not Google?

- Cost: free vs $5 / 1k requests for Google
- ToS: OSM allows redistribution + caching (we cache forever in DB);
  Google's Places ToS forbids most caching.
- Quality: Nominatim is good enough for venue-level (city + ICAO + venue
  string); we don't need traffic-grade routing data.

If quality becomes an issue, a Google Geocoding API fallback can swap
in behind the same `geocode()` interface (one env var + one block).

---

## 5. Schedule

GitHub Actions cron: **weekly Sunday 10:00 UTC** (one hour after
Vereinsflieger). One consolidated weekly stripe in the run-history tab.
Admins can fire on-demand from `/dashboard/admin/#crawler` → Events
group → **ICS feeds** button between Vereinsflieger refreshes.

---

## 6. Admin dashboard wiring (`tradeaero-refactor`)

Same three-line drop-in as Vereinsflieger:

| File | Change |
|---|---|
| `src/components/dashboard/admin/AdminCrawlerTab.tsx` | Append `{ key: "ics", label: "ICS feeds" }` to the Events trigger group; classify `ics-feed` as `"events"` in `getSourceCategory`; amber-700 source colour. |
| `src/app/api/admin/trigger-crawl/route.ts` | Add `ics: "crawl-ics.yml"` to `WORKFLOW_MAP`; append `"ics"` to the `source === "all"` fan-out. |

The crawler tab auto-populates source health / run history from
`crawler_runs`, so a row with `source_name='ics-feed'` appears in the
Events category as soon as the first run completes.

---

## 7. Testing

Local:

```bash
# Add a single test calendar to config.sources.ics.calendars (e.g.
# https://www.iana.org/time-zones for a known-good ICS without aviation
# context — purely to exercise the parser).
pnpm install
pnpm tsx src/index.ts --source ics --target events
```

End-to-end (against staging Supabase):

- Add 1–2 vetted feeds to the calendars array.
- Trigger from the admin Crawler tab → Events → ICS feeds.
- Open `/events` after the run — events from the feed appear. Their
  detail pages show the description from the ICS `DESCRIPTION:` field.
- Map view (when shipped) shows pins at geocoded coordinates.

---

## 8. Known limitations / out of scope

- **No RRULE expansion.** Recurring events appear once at their first
  occurrence. We can add `rrule` package + expansion later if a
  high-volume source demands it.
- **No VTIMEZONE custom rules.** TZID names are trusted; custom DAYLIGHT/
  STANDARD blocks ignored. All major IANA zones supported by `Intl`.
- **No image fetching from feeds.** ICS doesn't carry images. Future
  enrichment job could scrape the organiser site for hero images.
- **No per-event ToS check.** We trust the publisher's decision to
  publish a public `.ics` feed. If a site requests removal we
  blocklist their URL by removing the calendar entry.
