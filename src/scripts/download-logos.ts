import "dotenv/config";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

/**
 * Download aircraft manufacturer logos for ALL manufacturers in aircraft_reference_specs.
 *
 * Strategy (3-tier fallback):
 * 1. Wikimedia Commons — Claude Haiku finds the best logo URL
 * 2. Clearbit Logo API — free, by manufacturer website domain
 * 3. Google Favicon — last resort, by manufacturer website domain
 *
 * Usage: npx tsx src/scripts/download-logos.ts
 * Requires: BRIGHT_DATA_PROXY_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 */

const OUTPUT_DIR = process.env.LOGO_OUTPUT_DIR
  ? path.resolve(process.env.LOGO_OUTPUT_DIR)
  : path.resolve(__dirname, "../../../TradeAero-Refactor/public/assets/logos");

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Check if buffer contains a valid PNG or JPEG image > minSize bytes */
function isValidImage(buf: Buffer, minSize: number = 2000): boolean {
  if (buf.length < minSize) return false;
  // Not HTML
  if (buf.toString("utf8", 0, 15).includes("<!DOCTYPE") || buf.toString("utf8", 0, 5) === "<html") return false;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isSvg = buf.toString("utf8", 0, 100).includes("<svg");
  return isPng || isJpeg || isSvg;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "image/png,image/webp,image/jpeg,image/*,*/*;q=0.8",
  Referer: "https://www.google.com/",
};

/** Download an image URL via Bright Data proxy (undici fetch with dispatcher) */
async function downloadViaProxy(
  url: string,
  proxy: ProxyAgent,
  timeoutMs: number = 15000
): Promise<Buffer | null> {
  try {
    const resp = await undiciFetch(url, {
      headers: BROWSER_HEADERS,
      dispatcher: proxy,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/** Download an image URL directly (no proxy — for Clearbit, Google, etc.) */
async function downloadDirect(
  url: string,
  timeoutMs: number = 10000
): Promise<Buffer | null> {
  try {
    const resp = await undiciFetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

async function main() {
  const proxyUrl = process.env.BRIGHT_DATA_PROXY_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!proxyUrl) { console.error("BRIGHT_DATA_PROXY_URL not set"); process.exit(1); }
  if (!supabaseUrl || !supabaseKey) { console.error("SUPABASE_URL/KEY not set"); process.exit(1); }
  if (!anthropicKey) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`Output directory not found: ${OUTPUT_DIR}`);
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic();
  const proxy = new ProxyAgent(proxyUrl);

  // 1. Fetch ALL unique manufacturers from aircraft_reference_specs
  const { data: specs } = await supabase
    .from("aircraft_reference_specs")
    .select("manufacturer");

  if (!specs || specs.length === 0) {
    console.error("No manufacturers found in aircraft_reference_specs");
    process.exit(1);
  }

  const manufacturers = [...new Set(specs.map((s: any) => s.manufacturer as string))].sort();
  console.log(`Found ${manufacturers.length} unique manufacturers in aircraft_reference_specs\n`);

  let ok = 0;
  let skipped = 0;
  let fail = 0;

  for (const mfg of manufacturers) {
    const slug = nameToSlug(mfg);
    const outPath = path.join(OUTPUT_DIR, `${slug}-logo.png`);

    // Skip if a valid PNG/JPEG logo already exists
    if (fs.existsSync(outPath)) {
      const existing = fs.readFileSync(outPath);
      if (isValidImage(existing)) {
        console.log(`  SKIP ${mfg} (valid logo: ${(existing.length / 1024).toFixed(1)}KB)`);
        skipped++;
        continue;
      }
      // Remove invalid/placeholder file so we re-download
      fs.unlinkSync(outPath);
      console.log(`  CLEAN ${mfg} (removed invalid file: ${existing.length} bytes)`);
    }

    try {
      // ── TIER 1: Ask Claude for Wikimedia logo URL + manufacturer website domain ──
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        temperature: 0,
        system: `You are a helper that finds aircraft manufacturer logos.
Given an aircraft manufacturer name, return TWO lines:
Line 1: The best direct URL to a PNG thumbnail of their logo from Wikimedia Commons (upload.wikimedia.org), or "NONE" if not confident.
Line 2: The manufacturer's official website domain (e.g., "cessna.txtav.com" or "www.diamond-air.at"), or "NONE" if unknown.

Rules:
- For Wikimedia URLs, use /thumb/ PNG format: https://upload.wikimedia.org/wikipedia/commons/thumb/{path}/200px-{filename}.png
- Return ONLY two lines, no other text.`,
        messages: [{
          role: "user",
          content: `Aircraft manufacturer: ${mfg}`,
        }],
      });

      const text = (response.content[0].type === "text" ? response.content[0].text : "").trim();
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const wikimediaUrl = lines[0] && lines[0] !== "NONE" && lines[0].startsWith("https://upload.wikimedia.org") ? lines[0] : null;
      const websiteDomain = lines[1] && lines[1] !== "NONE" ? lines[1].replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null;

      let downloaded = false;

      // ── Try Wikimedia (via Bright Data proxy) ──
      if (wikimediaUrl) {
        const buf = await downloadViaProxy(wikimediaUrl, proxy);
        if (buf && isValidImage(buf)) {
          fs.writeFileSync(outPath, buf);
          console.log(`  OK   ${mfg} [wikimedia] → ${slug}-logo.png (${(buf.length / 1024).toFixed(1)}KB)`);
          ok++;
          downloaded = true;
        } else if (buf === null) {
          console.log(`  ──   ${mfg} [wikimedia] failed (download error), trying fallbacks...`);
        } else {
          console.log(`  ──   ${mfg} [wikimedia] invalid image (${buf.length}B), trying fallbacks...`);
        }
      }

      // ── TIER 2: Clearbit Logo API (direct — no proxy needed) ──
      if (!downloaded && websiteDomain) {
        const clearbitUrl = `https://logo.clearbit.com/${websiteDomain}`;
        const buf = await downloadDirect(clearbitUrl);
        if (buf && isValidImage(buf, 500)) {
          fs.writeFileSync(outPath, buf);
          console.log(`  OK   ${mfg} [clearbit] → ${slug}-logo.png (${(buf.length / 1024).toFixed(1)}KB)`);
          ok++;
          downloaded = true;
        } else {
          console.log(`  ──   ${mfg} [clearbit] no logo for ${websiteDomain}, trying favicon...`);
        }
      }

      // ── TIER 3: Google Favicon 128px (direct — no proxy needed) ──
      if (!downloaded && websiteDomain) {
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${websiteDomain}&sz=128`;
        const buf = await downloadDirect(faviconUrl);
        // Google favicon is smaller — accept > 500 bytes
        if (buf && buf.length > 500 && !buf.toString("utf8", 0, 15).includes("<!DOCTYPE")) {
          fs.writeFileSync(outPath, buf);
          console.log(`  OK   ${mfg} [favicon] → ${slug}-logo.png (${(buf.length / 1024).toFixed(1)}KB)`);
          ok++;
          downloaded = true;
        }
      }

      if (!downloaded) {
        console.log(`  FAIL ${mfg} (no logo found from any source)`);
        fail++;
      }

      // Polite delay between manufacturers (3s to avoid all rate limits)
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL ${mfg}: ${msg}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} downloaded, ${skipped} already existed, ${fail} failed/skipped`);
  console.log(`Total logos: ${ok + skipped} of ${manufacturers.length} manufacturers`);
}

main().catch(console.error);
