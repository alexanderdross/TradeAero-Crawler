import { randomUUID } from "crypto";
import sharp from "sharp";
import { supabase } from "../db/client.js";
import { logger } from "./logger.js";
import { fetchBinary } from "./fetch.js";

const MAX_CONCURRENT = 5;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Allowed image source domains — SSRF prevention (CWE-918) */
const ALLOWED_IMAGE_DOMAINS = [
  "www.helmuts-ul-seiten.de",
  "helmuts-ul-seiten.de",
  "www.aircraft24.de",
  "aircraft24.de",
  "www.aeromarkt.net",
  "aeromarkt.net",
];

/** URL patterns that indicate ad banners, not listing images */
const AD_PATTERNS = [
  /advertisement/i,
  /banner/i,
  /sponsor/i,
  /\bad[_-]?\d/i,
  /google_ads/i,
  /doubleclick/i,
];

/** JPEG magic bytes: FF D8 FF */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/** PNG magic bytes: 89 50 4E 47 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
/** WebP: starts with RIFF....WEBP */
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

function isAdBanner(url: string): boolean {
  return AD_PATTERNS.some((p) => p.test(url));
}

function isAllowedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_IMAGE_DOMAINS.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Download images from external URLs and upload them to Supabase Storage.
 * Returns array of {url, alt_text} matching the refactor app's ImageWithMeta format.
 */
export async function uploadImages(
  imageUrls: string[],
  altText: string,
  bucket: string = "aircraft-images"
): Promise<Array<{ url: string; alt_text: string }>> {
  if (imageUrls.length === 0) return [];

  const results: Array<{ url: string; alt_text: string }> = [];

  for (let i = 0; i < imageUrls.length; i += MAX_CONCURRENT) {
    const batch = imageUrls.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map((url) => downloadAndUpload(url, altText, bucket))
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      } else if (result.status === "rejected") {
        logger.warn("Image batch item failed", { reason: String(result.reason) });
      }
    }
  }

  return results;
}

async function downloadAndUpload(
  sourceUrl: string,
  altText: string,
  bucket: string
): Promise<{ url: string; alt_text: string } | null> {
  try {
    // Skip ad banners
    if (isAdBanner(sourceUrl)) {
      logger.debug("Skipped ad banner image", { sourceUrl });
      return null;
    }

    // SSRF prevention: only allow known source domains (CWE-918)
    if (!isAllowedDomain(sourceUrl)) {
      logger.warn("Blocked image from non-allowed domain", { sourceUrl });
      return null;
    }

    const result = await fetchBinary(sourceUrl);
    if (!result) {
      logger.warn("Failed to download image", { sourceUrl });
      return null;
    }

    let { buffer } = result;

    // Size limit — prevent memory exhaustion (CWE-400)
    if (buffer.length > MAX_IMAGE_SIZE) {
      logger.warn("Image exceeds size limit", { sourceUrl, size: buffer.length });
      return null;
    }

    // Magic byte validation — prevent malicious file uploads (CWE-434)
    const format = detectFormat(buffer);
    if (!format) {
      logger.debug("Skipped unsupported image format", { sourceUrl });
      return null;
    }

    // Convert WebP → JPEG via sharp
    if (format === "webp") {
      buffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
      logger.debug("Converted WebP to JPEG", { sourceUrl, size: buffer.length });
    }

    const ext = format === "png" ? "png" : "jpg";
    const mimeType = ext === "png" ? "image/png" : "image/jpeg";
    const fileName = `${randomUUID()}.${ext}`;
    const filePath = `listings/${fileName}`;

    const { error } = await supabase.storage
      .from(bucket)
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      logger.warn("Failed to upload image to storage", { filePath, error: error.message });
      return null;
    }

    const { data: publicData } = supabase.storage
      .from(bucket)
      .getPublicUrl(filePath);

    logger.debug("Uploaded image", { sourceUrl, storagePath: filePath });
    // Use alt_text key to match refactor app's ImageWithMeta normalizer
    return { url: publicData.publicUrl, alt_text: altText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Image download/upload error", { sourceUrl, error: msg });
    return null;
  }
}
