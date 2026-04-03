import "dotenv/config";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

/**
 * Download aircraft manufacturer logos for ALL manufacturers in aircraft_reference_specs.
 *
 * Strategy:
 * 1. Fetch all unique manufacturers from aircraft_reference_specs
 * 2. Skip manufacturers that already have a logo file
 * 3. Ask Claude Haiku for the best Wikimedia Commons logo URL for each manufacturer
 * 4. Download via Bright Data proxy
 * 5. Save to TradeAero-Refactor/public/assets/logos/{slug}-logo.png
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
  const agent = new HttpsProxyAgent(proxyUrl);

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

    // Skip if a valid PNG/JPEG logo already exists (check magic bytes, not just size)
    if (fs.existsSync(outPath)) {
      const existing = fs.readFileSync(outPath);
      const isPng = existing[0] === 0x89 && existing[1] === 0x50 && existing[2] === 0x4e && existing[3] === 0x47;
      const isJpeg = existing[0] === 0xff && existing[1] === 0xd8 && existing[2] === 0xff;
      if ((isPng || isJpeg) && existing.length > 2000) {
        console.log(`  SKIP ${mfg} (valid ${isPng ? "PNG" : "JPEG"}: ${(existing.length / 1024).toFixed(1)}KB)`);
        skipped++;
        continue;
      }
      // Remove invalid/placeholder file so we re-download
      fs.unlinkSync(outPath);
      console.log(`  CLEAN ${mfg} (removed invalid file: ${existing.length} bytes)`);
    }

    // 2. Ask Claude for the best logo URL
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        temperature: 0,
        system: `You are a helper that finds aircraft manufacturer logo URLs from Wikimedia Commons.
Given an aircraft manufacturer name, return the BEST direct URL to a PNG thumbnail of their logo from Wikimedia Commons.

Rules:
- URL must be from upload.wikimedia.org
- Use the /thumb/ PNG format: https://upload.wikimedia.org/wikipedia/commons/thumb/{path}/200px-{filename}.png
- Or the /wikipedia/en/thumb/ path for English Wikipedia logos
- If you're not confident a logo exists on Wikimedia, return "NONE"
- Return ONLY the URL or "NONE", nothing else`,
        messages: [{
          role: "user",
          content: `Aircraft manufacturer: ${mfg}`,
        }],
      });

      const logoUrl = (response.content[0].type === "text" ? response.content[0].text : "").trim();

      if (!logoUrl || logoUrl === "NONE" || !logoUrl.startsWith("https://upload.wikimedia.org")) {
        console.log(`  SKIP ${mfg} (no Wikimedia logo found)`);
        fail++;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // 3. Download via Bright Data proxy
      const imgResponse = await fetch(logoUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "image/png,image/webp,image/*,*/*;q=0.8",
          Referer: "https://commons.wikimedia.org/",
        },
        // @ts-ignore
        agent,
        signal: AbortSignal.timeout(15000),
      } as any);

      if (!imgResponse.ok) {
        console.log(`  FAIL ${mfg}: HTTP ${imgResponse.status} for ${logoUrl}`);
        fail++;
        continue;
      }

      const buffer = Buffer.from(await imgResponse.arrayBuffer());

      // Validate: must be > 500 bytes and not HTML
      if (buffer.length < 500) {
        console.log(`  FAIL ${mfg}: Too small (${buffer.length} bytes)`);
        fail++;
        continue;
      }
      if (buffer.toString("utf8", 0, 15).includes("<!DOCTYPE") || buffer.toString("utf8", 0, 5) === "<html") {
        console.log(`  FAIL ${mfg}: Got HTML, not image`);
        fail++;
        continue;
      }

      fs.writeFileSync(outPath, buffer);
      console.log(`  OK   ${mfg} → ${slug}-logo.png (${(buffer.length / 1024).toFixed(1)}KB)`);
      ok++;

      // Polite delay
      await new Promise((r) => setTimeout(r, 300));
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
