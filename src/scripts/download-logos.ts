import "dotenv/config";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as fs from "fs";
import * as path from "path";

/**
 * Download aircraft manufacturer logos from Wikimedia Commons via Bright Data proxy.
 *
 * Usage: npx tsx src/scripts/download-logos.ts
 * Requires: BRIGHT_DATA_PROXY_URL env var
 *
 * Output: PNG files saved to ../TradeAero-Refactor/public/assets/logos/{slug}-logo.png
 */

const LOGOS: Array<{ name: string; slug: string; url: string }> = [
  // Major GA manufacturers
  { name: "Pipistrel", slug: "pipistrel", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/Pipistrel_Logo.svg/200px-Pipistrel_Logo.svg.png" },
  { name: "Tecnam", slug: "tecnam", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Tecnam_logo.svg/200px-Tecnam_logo.svg.png" },
  { name: "Robin", slug: "robin", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/Robin_Aircraft_logo.svg/200px-Robin_Aircraft_logo.svg.png" },
  { name: "Pilatus", slug: "pilatus", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/Pilatus_Aircraft_logo.svg/200px-Pilatus_Aircraft_logo.svg.png" },
  { name: "Bombardier", slug: "bombardier", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/Bombardier_Logo.svg/200px-Bombardier_Logo.svg.png" },
  { name: "Embraer", slug: "embraer", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Embraer_logo_%282019%29.svg/200px-Embraer_logo_%282019%29.svg.png" },
  { name: "Dassault", slug: "dassault", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/Dassault_Aviation_Logo.svg/200px-Dassault_Aviation_Logo.svg.png" },
  { name: "Gulfstream", slug: "gulfstream", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Gulfstream_Aerospace_logo.svg/200px-Gulfstream_Aerospace_logo.svg.png" },
  { name: "Robinson", slug: "robinson", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c6/Robinson_Helicopter_Company_logo.svg/200px-Robinson_Helicopter_Company_logo.svg.png" },
  { name: "Bell", slug: "bell", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/Bell_logo_2018.svg/200px-Bell_logo_2018.svg.png" },
  { name: "Grumman", slug: "grumman", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Grumman_logo.svg/200px-Grumman_logo.svg.png" },
  { name: "Daher/Socata", slug: "socata", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3c/Daher_Logo.svg/200px-Daher_Logo.svg.png" },
  { name: "Extra", slug: "extra", url: "https://upload.wikimedia.org/wikipedia/de/thumb/5/5a/Extra_Flugzeugproduktions-_und_Vertriebs-GmbH_logo.svg/200px-Extra_Flugzeugproduktions-_und_Vertriebs-GmbH_logo.svg.png" },
  // UL / LSA
  { name: "AutoGyro", slug: "autogyro", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/AutoGyro_logo.svg/200px-AutoGyro_logo.svg.png" },
  { name: "Flight Design", slug: "flight-design", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Flight_Design_logo.svg/200px-Flight_Design_logo.svg.png" },
  { name: "Evektor", slug: "evektor", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/Evektor_logo.svg/200px-Evektor_logo.svg.png" },
  { name: "Remos", slug: "remos", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Remos_Aircraft_Logo.png/200px-Remos_Aircraft_Logo.png" },
  { name: "Maule", slug: "maule", url: "https://upload.wikimedia.org/wikipedia/en/thumb/5/5e/Maule_Air_logo.png/200px-Maule_Air_logo.png" },
  // Jet manufacturers
  { name: "Learjet", slug: "learjet", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Learjet_Logo.svg/200px-Learjet_Logo.svg.png" },
  { name: "HondaJet", slug: "hondajet", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b7/Honda_Aircraft_Company_logo.svg/200px-Honda_Aircraft_Company_logo.svg.png" },
  // Helicopters
  { name: "Airbus Helicopters", slug: "airbus-helicopters", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/24/Airbus_Helicopters_logo_2014.svg/200px-Airbus_Helicopters_logo_2014.svg.png" },
  { name: "Leonardo", slug: "leonardo", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/73/Leonardo_logo.svg/200px-Leonardo_logo.svg.png" },
  { name: "Sikorsky", slug: "sikorsky", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Sikorsky_Aircraft_Corporation_logo.svg/200px-Sikorsky_Aircraft_Corporation_logo.svg.png" },
  // Additional
  { name: "Aerospool", slug: "aerospool", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/Aerospool_Logo.png/200px-Aerospool_Logo.png" },
  { name: "Bristell", slug: "bristell", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/BRM_Aero_logo.svg/200px-BRM_Aero_logo.svg.png" },
  { name: "DynAero", slug: "dynaero", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/DynAero_logo.svg/200px-DynAero_logo.svg.png" },
  { name: "Comco Ikarus", slug: "comco-ikarus", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Comco_Ikarus_logo.svg/200px-Comco_Ikarus_logo.svg.png" },
  { name: "Rans", slug: "rans", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e6/RANS_Designs_logo.svg/200px-RANS_Designs_logo.svg.png" },
];

const OUTPUT_DIR = path.resolve(__dirname, "../../../TradeAero-Refactor/public/assets/logos");

async function main() {
  const proxyUrl = process.env.BRIGHT_DATA_PROXY_URL;
  if (!proxyUrl) {
    console.error("BRIGHT_DATA_PROXY_URL not set");
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`Output directory not found: ${OUTPUT_DIR}`);
    process.exit(1);
  }

  const agent = new HttpsProxyAgent(proxyUrl);
  let ok = 0;
  let fail = 0;

  for (const logo of LOGOS) {
    const outPath = path.join(OUTPUT_DIR, `${logo.slug}-logo.png`);

    // Skip if logo already exists and is > 1KB (real image)
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      console.log(`  SKIP ${logo.name} (already exists: ${fs.statSync(outPath).size} bytes)`);
      ok++;
      continue;
    }

    try {
      const response = await fetch(logo.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "image/png,image/webp,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        // @ts-ignore - agent works with node-fetch
        agent,
        signal: AbortSignal.timeout(15000),
      } as any);

      if (!response.ok) {
        console.log(`  FAIL ${logo.name}: HTTP ${response.status}`);
        fail++;
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Verify it's actually an image (not HTML error page)
      if (buffer.length < 500 || buffer.toString("utf8", 0, 15).includes("<!DOCTYPE")) {
        console.log(`  FAIL ${logo.name}: Got HTML instead of image (${buffer.length} bytes)`);
        fail++;
        continue;
      }

      fs.writeFileSync(outPath, buffer);
      console.log(`  OK   ${logo.name} (${buffer.length} bytes) → ${logo.slug}-logo.png`);
      ok++;

      // Polite delay
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL ${logo.name}: ${msg}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} OK, ${fail} failed`);
}

main().catch(console.error);
