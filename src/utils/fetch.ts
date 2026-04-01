import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Fetch a URL with polite crawling: User-Agent header, retry logic, delay,
 * and optional Bright Data proxy support.
 *
 * Proxy is used when BRIGHT_DATA_PROXY_URL is set in environment.
 * Format: http://username:password@brd.superproxy.io:22225
 */
export async function fetchPage(url: string, options?: { proxy?: boolean }): Promise<string> {
  const maxRetries = 3;
  const useProxy = (options?.proxy ?? true) && !!getProxyUrl();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fetchOptions: RequestInit & { agent?: unknown } = {
        headers: {
          "User-Agent": config.crawler.userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
        },
      };

      // Use Bright Data proxy if configured
      if (useProxy) {
        const proxyUrl = getProxyUrl()!;
        const agent = new HttpsProxyAgent(proxyUrl);
        (fetchOptions as any).agent = agent;
        if (attempt === 1) {
          logger.debug("Using Bright Data proxy", { url });
        }
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      if (useProxy) trackProxyBytes(html.length);
      logger.info(`Fetched ${url}`, { bytes: html.length, attempt, proxy: useProxy });
      return html;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Fetch attempt ${attempt}/${maxRetries} failed for ${url}`, { error: msg, proxy: useProxy });

      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts: ${msg}`);
      }

      // Exponential backoff: 2s, 4s
      await delay(2000 * attempt);
    }
  }

  throw new Error(`Failed to fetch ${url}`);
}

/**
 * Fetch a binary resource (e.g., image) with optional proxy support.
 */
export async function fetchBinary(url: string, options?: { proxy?: boolean }): Promise<{ buffer: Buffer; contentType: string } | null> {
  const useProxy = (options?.proxy ?? false) && !!getProxyUrl();

  try {
    const fetchOptions: RequestInit & { agent?: unknown } = {
      headers: {
        "User-Agent": config.crawler.userAgent,
        Accept: "image/*",
      },
    };

    if (useProxy) {
      const agent = new HttpsProxyAgent(getProxyUrl()!);
      (fetchOptions as any).agent = agent;
    }

    const response = await fetch(url, fetchOptions);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (useProxy && buffer.length > 0) trackProxyBytes(buffer.length);
    return buffer.length > 0 ? { buffer, contentType } : null;
  } catch {
    return null;
  }
}

/** Cumulative proxy bytes transferred in this process */
let _proxyBytesTransferred = 0;

export function getProxyBytesTransferred(): number {
  return _proxyBytesTransferred;
}

export function resetProxyBytesTransferred(): void {
  _proxyBytesTransferred = 0;
}

function trackProxyBytes(bytes: number): void {
  _proxyBytesTransferred += bytes;
}

function getProxyUrl(): string | null {
  return process.env.BRIGHT_DATA_PROXY_URL || null;
}

/** Polite delay between requests */
export function delay(ms?: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms ?? config.crawler.delayMs));
}
