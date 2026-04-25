import "dotenv/config";

export interface SourceConfig {
  name: string;
  baseUrl: string;
  aircraft: string[];
  parts: string[];
  /**
   * Public-calendar event URLs. Used by the vereinsflieger crawler; other
   * sources leave this undefined.
   */
  events?: string[];
  /** ICS calendar feeds (one entry per club / org). Used by the ics crawler. */
  calendars?: IcsCalendar[];
  /** Use Bright Data proxy for this source (default: false) */
  useProxy?: boolean;
  /**
   * Queue a claim-invite candidate row every time a NEW listing from this
   * source is inserted. The Refactor-side cron drains the queue behind a
   * kill switch + legal gate. v1 scope: Helmut only. See
   * TradeAero-Refactor/docs/COLD_EMAIL_CLAIM_CONCEPT.md §8.
   */
  sendColdEmailInvite?: boolean;
}

/**
 * One iCalendar feed in the events pipeline. Add new entries to
 * `config.sources.ics.calendars[]` as new clubs / orgs come online.
 *
 * Vetting checklist before adding a feed:
 *   1. The calendar is meant for public consumption (linked from a
 *      "Calendar" / "Events" page on the org's site).
 *   2. The robots.txt of the host doesn't disallow the .ics path.
 *   3. The feed URL is stable (not a per-session token).
 *   4. defaultCategory is one of `seminar | competition | flying-camp |
 *      airfield-festival | trade-fair | airshow | auction | webinar |
 *      meetup | general` (matches event_categories.code).
 */
export interface IcsCalendar {
  /** Human-readable label, surfaced as the venue fallback when the ICS
   *  LOCATION is empty. e.g. "DULV Sport Pilot Calendar". */
  name: string;
  /** Canonical .ics URL. */
  url: string;
  /** ISO 3166-1 alpha-2 country code for events on this feed (most clubs
   *  hold all events in one country). */
  country: string;
  /** event_categories.code to use when the ICS event has no CATEGORIES
   *  line, or when none of its categories match an existing code. */
  defaultCategory: string;
  /** Optional default IANA timezone — overrides DTSTART;TZID when both
   *  are absent. Defaults to "Europe/Berlin". */
  timezone?: string;
  /** Source language for the title/description. Drives the bilingual-min
   *  translator (source + EN). Defaults to "en". */
  sourceLocale?: string;
  /** Friendly name shown as `aviation_events.organizer_name` when the ICS
   *  feed doesn't carry per-event organisers (most don't). */
  organiserName?: string;
}

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  },
  crawler: {
    userAgent:
      process.env.CRAWLER_USER_AGENT ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    delayMs: Number(process.env.CRAWL_DELAY_MS ?? 2000),
  },
  proxy: {
    /** Bright Data proxy URL: http://user:pass@brd.superproxy.io:22225 */
    url: process.env.BRIGHT_DATA_PROXY_URL ?? "",
  },
  sources: {
    helmut: {
      name: "helmuts-ul-seiten.de",
      baseUrl: "https://www.helmuts-ul-seiten.de",
      aircraft: [
        "https://www.helmuts-ul-seiten.de/verkauf1a.html",
        "https://www.helmuts-ul-seiten.de/verkauf1b.html",
        "https://www.helmuts-ul-seiten.de/verkauf1c.html",
      ],
      parts: ["https://www.helmuts-ul-seiten.de/verkauf2.html"],
      useProxy: false,
      sendColdEmailInvite: true,
    },
    aircraft24: {
      name: "aircraft24.de",
      baseUrl: "https://www.aircraft24.de",
      aircraft: [
        "https://www.aircraft24.de/singleprop/index.htm",
        "https://www.aircraft24.de/multiprop/index.htm",
        "https://www.aircraft24.de/turboprop/index.htm",
        "https://www.aircraft24.de/jet/index.htm",
        "https://www.aircraft24.de/helicopter/index.htm",
      ],
      parts: [],
      useProxy: true,
    },
    aeromarkt: {
      name: "aeromarkt.net",
      baseUrl: "https://www.aeromarkt.net",
      aircraft: [
        "https://www.aeromarkt.net/Kolbenmotorflugzeuge/",
        "https://www.aeromarkt.net/Kolbenmotorflugzeuge/Leichtflugzeuge-UL-VLA-ELA/",
        "https://www.aeromarkt.net/Kolbenmotorflugzeuge/Experimentals-Classics/",
        "https://www.aeromarkt.net/Jets-Turboprops/",
        "https://www.aeromarkt.net/Helikopter-Gyrocopter/",
        "https://www.aeromarkt.net/Sonstige-Luftfahrzeuge/",
      ],
      parts: [
        "https://www.aeromarkt.net/Triebwerke/",
        "https://www.aeromarkt.net/Avionik-Instrumente/",
      ],
      useProxy: true,
    },
    /**
     * Generic ICS / iCal feed source. Add per-club entries to
     * `calendars` to ingest events without writing a per-site parser.
     * Most aviation orgs already publish .ics feeds; this is the
     * highest-leverage ingestion path before bespoke crawlers.
     *
     * Empty by default — populate after vetting per the IcsCalendar
     * docstring above.
     */
    ics: {
      name: "ics-feed",
      baseUrl: "",
      aircraft: [],
      parts: [],
      calendars: [] as IcsCalendar[],
      useProxy: false,
      sendColdEmailInvite: false,
    } satisfies SourceConfig,
    vereinsflieger: {
      name: "vereinsflieger.de",
      baseUrl: "https://vereinsflieger.de",
      aircraft: [],
      parts: [],
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
    },
  } satisfies Record<string, SourceConfig>,
  /** Default country for German sources */
  defaultCountry: "Germany",
  /** Default currency */
  defaultCurrency: "EUR",
} as const;

export function validateConfig(): void {
  if (!config.supabase.url) {
    throw new Error("SUPABASE_URL is required");
  }
  if (!config.supabase.serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[CONFIG] WARNING: ANTHROPIC_API_KEY is not set — translations will be skipped, all locales will use German text");
  }
}
