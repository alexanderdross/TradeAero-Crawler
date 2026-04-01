import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Fetch a URL with polite crawling: User-Agent header, retry logic, and delay.
 */
export async function fetchPage(url: string): Promise<string> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": config.crawler.userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      logger.info(`Fetched ${url}`, { bytes: html.length, attempt });
      return html;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Fetch attempt ${attempt}/${maxRetries} failed for ${url}`, { error: msg });

      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts: ${msg}`);
      }

      // Exponential backoff: 2s, 4s
      await delay(2000 * attempt);
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`Failed to fetch ${url}`);
}

/** Polite delay between requests */
export function delay(ms?: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms ?? config.crawler.delayMs));
}
