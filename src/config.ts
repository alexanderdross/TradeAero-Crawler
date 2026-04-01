import "dotenv/config";

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  },
  crawler: {
    userAgent:
      process.env.CRAWLER_USER_AGENT ?? "TradeAero-Crawler/1.0",
    delayMs: Number(process.env.CRAWL_DELAY_MS ?? 2000),
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
    },
  },
  /** Default country for Helmut's listings (Germany) */
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
}
