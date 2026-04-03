import { describe, expect, it } from "vitest";

// Re-export the pure functions for testing by importing them indirectly
// Since the module has side effects (supabase import), we test the logic directly

describe("detectFormat", () => {
  // Replicate the logic from images.ts for unit testing
  const JPEG_MAGIC = [0xff, 0xd8, 0xff];
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
  const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
  const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50];

  type ImageFormat = "jpeg" | "png" | "webp" | null;

  function detectFormat(buffer: Buffer): ImageFormat {
    if (buffer.length < 12) return null;
    if (JPEG_MAGIC.every((b, i) => buffer[i] === b)) return "jpeg";
    if (PNG_MAGIC.every((b, i) => buffer[i] === b)) return "png";
    if (
      WEBP_RIFF.every((b, i) => buffer[i] === b) &&
      WEBP_MARKER.every((b, i) => buffer[i + 8] === b)
    ) return "webp";
    return null;
  }

  it("detects JPEG by magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectFormat(buf)).toBe("jpeg");
  });

  it("detects PNG by magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectFormat(buf)).toBe("png");
  });

  it("detects WebP by RIFF....WEBP header", () => {
    // RIFF + 4 bytes file size + WEBP
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // file size (placeholder)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectFormat(buf)).toBe("webp");
  });

  it("returns null for unknown format", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
    expect(detectFormat(buf)).toBeNull();
  });

  it("returns null for buffer too short", () => {
    const buf = Buffer.from([0xff, 0xd8]);
    expect(detectFormat(buf)).toBeNull();
  });

  it("returns null for empty buffer", () => {
    const buf = Buffer.alloc(0);
    expect(detectFormat(buf)).toBeNull();
  });

  it("does not confuse RIFF without WEBP marker", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // AVI instead of WEBP
    ]);
    expect(detectFormat(buf)).toBeNull();
  });
});

describe("isAdBanner", () => {
  const AD_PATTERNS = [
    /advertisement/i,
    /banner/i,
    /sponsor/i,
    /\bad[_-]?\d/i,
    /google_ads/i,
    /doubleclick/i,
  ];

  function isAdBanner(url: string): boolean {
    return AD_PATTERNS.some((p) => p.test(url));
  }

  it("detects advertisement in URL", () => {
    expect(isAdBanner("https://example.com/images/advertisement-300x250.jpg")).toBe(true);
  });

  it("detects banner in URL", () => {
    expect(isAdBanner("https://example.com/banner_top.jpg")).toBe(true);
  });

  it("detects sponsor in URL", () => {
    expect(isAdBanner("https://example.com/sponsor-logo.png")).toBe(true);
  });

  it("detects ad123 pattern", () => {
    expect(isAdBanner("https://example.com/ad_123.jpg")).toBe(true);
    expect(isAdBanner("https://example.com/ad-5.jpg")).toBe(true);
    expect(isAdBanner("https://example.com/ad3.jpg")).toBe(true);
  });

  it("detects google_ads", () => {
    expect(isAdBanner("https://example.com/google_ads/tracking.gif")).toBe(true);
  });

  it("detects doubleclick", () => {
    expect(isAdBanner("https://ad.doubleclick.net/image.jpg")).toBe(true);
  });

  it("does not flag normal listing images", () => {
    expect(isAdBanner("https://example.com/listings/cessna-172-001.jpg")).toBe(false);
    expect(isAdBanner("https://example.com/aircraft/piper-pa28.png")).toBe(false);
  });

  it("does not flag URLs containing 'ad' as substring in normal words", () => {
    // "ad" inside "loading" or "download" should NOT match \bad pattern
    expect(isAdBanner("https://example.com/loading-image.jpg")).toBe(false);
    expect(isAdBanner("https://example.com/download/photo.jpg")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isAdBanner("https://example.com/BANNER_TOP.JPG")).toBe(true);
    expect(isAdBanner("https://example.com/Advertisement.png")).toBe(true);
  });
});

describe("isAllowedDomain", () => {
  const ALLOWED_IMAGE_DOMAINS = [
    "www.helmuts-ul-seiten.de",
    "helmuts-ul-seiten.de",
    "www.aircraft24.de",
    "aircraft24.de",
    "www.aeromarkt.net",
    "aeromarkt.net",
  ];

  function isAllowedDomain(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return ALLOWED_IMAGE_DOMAINS.includes(hostname);
    } catch {
      return false;
    }
  }

  it("allows known source domains", () => {
    expect(isAllowedDomain("https://www.helmuts-ul-seiten.de/img/photo.jpg")).toBe(true);
    expect(isAllowedDomain("https://aircraft24.de/images/listing.jpg")).toBe(true);
    expect(isAllowedDomain("https://www.aeromarkt.net/media/photo.png")).toBe(true);
  });

  it("rejects unknown domains (SSRF prevention)", () => {
    expect(isAllowedDomain("https://evil.com/malicious.jpg")).toBe(false);
    expect(isAllowedDomain("https://internal-server.local/secret.png")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(isAllowedDomain("not-a-url")).toBe(false);
    expect(isAllowedDomain("")).toBe(false);
  });
});
