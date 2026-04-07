import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { logger } from "./logger.js";

/** Timeout for all fetch calls — prevents hanging connections (CWE-400) */
const FETCH_TIMEOUT_MS = 30_000;
/** Max page size in bytes — prevents memory exhaustion */
const MAX_PAGE_SIZE = 10 * 1024 * 1024;

/**
 * Fetch a URL with polite crawling: User-Agent header, retry logic, delay,
 * timeout, and optional Bright Data proxy support.
 */
export async function fetchPage(url: string, options?: { proxy?: boolean }): Promise<string> {
  const maxRetries = 3;
  const useProxy = (options?.proxy ?? true) && !!getProxyUrl();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fetchOptions: RequestInit & { agent?: unknown } = {
        headers: {
          "User-Agent": config.crawler.userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          Referer: "",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      };

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

      // Check Content-Length before reading body
      const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_PAGE_SIZE) {
        throw new Error(`Response too large: ${contentLength} bytes (limit: ${MAX_PAGE_SIZE})`);
      }

      const html = await response.text();

      if (html.length > MAX_PAGE_SIZE) {
        throw new Error(`Response body too large: ${html.length} bytes`);
      }

      if (useProxy) trackProxyBytes(html.length);
      logger.info(`Fetched ${url}`, { bytes: html.length, attempt, proxy: useProxy });
      return html;
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      const msg = redactProxyUrl(rawMsg);
      logger.warn(`Fetch attempt ${attempt}/${maxRetries} failed for ${url}`, { error: msg, proxy: useProxy });

      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts: ${msg}`);
      }

      await delay(2000 * attempt);
    }
  }

  throw new Error(`Failed to fetch ${url}`);
}

/**
 * Fetch a binary resource (e.g., image) with optional proxy support and timeout.
 */
export async function fetchBinary(url: string, options?: { proxy?: boolean }): Promise<{ buffer: Buffer; contentType: string } | null> {
  const useProxy = (options?.proxy ?? false) && !!getProxyUrl();

  try {
    const fetchOptions: RequestInit & { agent?: unknown } = {
      headers: {
        "User-Agent": config.crawler.userAgent,
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
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

/** Strip credentials from URLs before logging (CWE-532) */
export function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^:]+:[^@]+@/, "//***@");
}

/** Polite delay between requests */
export function delay(ms?: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms ?? config.crawler.delayMs));
}
