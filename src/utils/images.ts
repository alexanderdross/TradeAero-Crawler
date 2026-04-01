import { randomUUID } from "crypto";
import { supabase } from "../db/client.js";
import { logger } from "./logger.js";
import { fetchBinary } from "./fetch.js";

const MAX_CONCURRENT = 3;

/**
 * Download images from external URLs and upload them to Supabase Storage.
 * Returns an array of {url, alt} objects with Supabase public URLs.
 *
 * Matches the existing TradeAero pattern:
 *   Bucket: "aircraft-images" or "parts-images"
 *   Path: "listings/{uuid}.jpg"
 *   URL: https://<project>.supabase.co/storage/v1/object/public/{bucket}/listings/{uuid}.jpg
 */
export async function uploadImages(
  imageUrls: string[],
  altText: string,
  bucket: string = "aircraft-images"
): Promise<Array<{ url: string; alt: string }>> {
  if (imageUrls.length === 0) return [];

  const results: Array<{ url: string; alt: string }> = [];

  // Process in batches to limit concurrency
  for (let i = 0; i < imageUrls.length; i += MAX_CONCURRENT) {
    const batch = imageUrls.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map((url) => downloadAndUpload(url, altText, bucket))
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      }
    }
  }

  return results;
}

async function downloadAndUpload(
  sourceUrl: string,
  altText: string,
  bucket: string
): Promise<{ url: string; alt: string } | null> {
  try {
    // Download the image (uses proxy if configured)
    const result = await fetchBinary(sourceUrl);
    if (!result) {
      logger.warn("Failed to download image", { sourceUrl });
      return null;
    }

    const { buffer, contentType } = result;

    // Determine extension: keep png as png, everything else as jpg
    const ext = contentType.includes("png") ? "png" : "jpg";
    const mimeType = ext === "png" ? "image/png" : "image/jpeg";
    const fileName = `${randomUUID()}.${ext}`;
    const filePath = `listings/${fileName}`;

    // Upload to Supabase Storage
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

    // Get public URL
    const { data: publicData } = supabase.storage
      .from(bucket)
      .getPublicUrl(filePath);

    logger.debug("Uploaded image", { sourceUrl, storagePath: filePath });
    return { url: publicData.publicUrl, alt: altText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Image download/upload error", { sourceUrl, error: msg });
    return null;
  }
}
