import "dotenv/config";

export interface SourceConfig {
  name: string;
  baseUrl: string;
  aircraft: string[];
  parts: string[];
  /** Use Bright Data proxy for this source (default: false) */
  useProxy?: boolean;
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
  } satisfies Record<string, SourceConfig>,
  /** Default country for German sources */
  defaultCountry: "DE",
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
