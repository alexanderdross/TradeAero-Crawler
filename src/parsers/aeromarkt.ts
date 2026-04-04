import * as cheerio from "cheerio";
import { logger } from "../utils/logger.js";
import type { ParsedAircraftListing, ParsedPartsListing } from "../types.js";

/** Build a description that passes the 10+ char DB constraint */
function buildDescription(
  manufacturer: string,
  model: string,
  year: number | null,
  price: number | null,
  priceNegotiable: boolean
): string {
  const parts: string[] = [];
  if (manufacturer) parts.push(`${manufacturer} ${model}`.trim());
  if (year && year >= 1900) parts.push(`Baujahr ${year}`);
  if (price) parts.push(`Preis: ${price.toLocaleString("de-DE")} EUR`);
  else if (priceNegotiable) parts.push("Preis Verhandlungssache");
  else parts.push("Preis auf Anfrage");
  parts.push("Angebot auf aeromarkt.net");
  return parts.join(". ") + ".";
}

/**
 * Parse aircraft listings from aeromarkt.net (Shopware 6 site).
 *
 * Listing structure (server-rendered):
 * - Each listing is a `div.listview-item`
 * - Manufacturer in `h2 strong`, Model in `h3 strong`
 * - Price in `p.price span`
 * - Year from text "Baujahr: XXXX"
 * - Detail link from `a[href][title]`
 * - Images from `img.img-fluid`
 * - Pagination via `li.page-next a.page-link`
 */
export function parseAeromarktAircraftPage(
  html: string,
  pageUrl: string,
  sourceName: string
): { listings: ParsedAircraftListing[]; nextPageUrl: string | null } {
  const $ = cheerio.load(html);
  const listings: ParsedAircraftListing[] = [];

  $("div.listview-item").each((i, el) => {
    try {
      const $item = $(el);

      // Extract manufacturer and model from h2/h3 strong tags
      const manufacturer = $item.find(".new-lfz-description h2 strong").text().trim();
      const model = $item.find(".new-lfz-description h3 strong").text().trim();

      // Build title from manufacturer + model
      const title = [manufacturer, model].filter(Boolean).join(" ").trim();
      if (!title || title.length < 3) return;

      // Detail URL
      const detailLink = $item.find(".new-lfz-description h2 a").attr("href")
        ?? $item.find("a[href][title]").first().attr("href");
      const detailUrl = detailLink
        ? (detailLink.startsWith("http") ? detailLink : `https://www.aeromarkt.net${detailLink}`)
        : pageUrl;

      // Price extraction
      const priceText = $item.find("p.price span").text().trim();
      let price: number | null = null;
      let priceNegotiable = false;

      if (priceText.includes("Preis auf Anfrage")) {
        price = null;
        priceNegotiable = true;
      } else if (priceText.includes("Verhandlungssache")) {
        priceNegotiable = true;
        const priceMatch = priceText.match(/([\d.,]+)\s*€/);
        if (priceMatch) {
          price = parseFloat(priceMatch[1].replace(/\./g, "").replace(",", "."));
          if (isNaN(price)) price = null;
        }
      } else {
        const priceMatch = priceText.match(/([\d.,]+)\s*€/) ?? priceText.match(/€\s*([\d.,]+)/);
        if (priceMatch) {
          price = parseFloat(priceMatch[1].replace(/\./g, "").replace(",", "."));
          if (isNaN(price)) price = null;
        }
      }

      // Year extraction
      const itemText = $item.text();
      const yearMatch = itemText.match(/Baujahr:\s*(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
      // Skip year 0 (invalid)
      if (year !== null && year < 1900) return;

      // Image extraction
      const images: string[] = [];
      $item.find("img.img-fluid").each((_, img) => {
        const src = $(img).attr("src");
        if (src && !src.includes("no_image") && !src.includes("banner") && !src.includes("logo")) {
          const absoluteUrl = src.startsWith("http") ? src : `https://www.aeromarkt.net${src}`;
          images.push(absoluteUrl);
        }
      });

      // Extract specs visible in the index card text
      const cardText = $item.text();
      const ttCardMatch = cardText.match(/(?:TTAF|TT(?:AF)?|Betriebsstunden|Flugstunden)[:\s]*([\d.,]+)/i);
      const totalTime = ttCardMatch ? parseFloat(ttCardMatch[1].replace(/\./g, "").replace(",", ".")) : null;
      const engineCardMatch = cardText.match(/(?:Motorstunden|TTSN|TTE)[:\s]*([\d.,]+)/i);
      const engineHours = engineCardMatch ? parseFloat(engineCardMatch[1].replace(/\./g, "").replace(",", ".")) : null;
      const cyclesCardMatch = cardText.match(/(?:Landungen|LDG|Ldg\.?)[:\s]*([\d.,]+)/i);
      const cycles = cyclesCardMatch ? parseInt(cyclesCardMatch[1].replace(/\./g, ""), 10) : null;
      const locationCardMatch = cardText.match(/(?:Standort|Ort)[:\s]*([A-Za-zÄÖÜäöüß\s\-,]+)/i);
      const location = locationCardMatch ? locationCardMatch[1].trim().split(/[\n,]/)[0].trim() : null;

      listings.push({
        sourceId: detailUrl,
        sourceUrl: detailUrl,
        sourceName,
        postedDate: null,
        title,
        description: buildDescription(manufacturer, model, year, price, priceNegotiable),
        year,
        engine: null,
        totalTime,
        engineHours,
        cycles,
        mtow: null,
        rescueSystem: null,
        annualInspection: null,
        dulvRef: null,
        price,
        priceNegotiable,
        location,
        city: null,
        airfieldName: null,
        icaoCode: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        imageUrls: images,
        registration: null,
        serialNumber: null,
        airworthy: null,
        avionicsText: null,
        country: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse aeromarkt listing block ${i}`, { pageUrl, error: msg });
    }
  });

  // Pagination: find "next page" link
  let nextPageUrl: string | null = null;
  const nextLink = $("li.page-next a.page-link").attr("href");
  if (nextLink) {
    const base = new URL(pageUrl);
    if (nextLink.startsWith("http")) {
      nextPageUrl = nextLink;
    } else if (nextLink.startsWith("?")) {
      nextPageUrl = `${base.origin}${base.pathname}${nextLink}`;
    } else {
      nextPageUrl = `${base.origin}${nextLink}`;
    }
  }

  logger.info("Parsed aeromarkt aircraft page", {
    pageUrl,
    listings: listings.length,
    hasNext: !!nextPageUrl,
  });

  return { listings, nextPageUrl };
}

/**
 * Parse parts listings from aeromarkt.net.
 * Same structure as aircraft but in parts categories (Triebwerke, Avionik).
 */
export function parseAeromarktPartsPage(
  html: string,
  pageUrl: string,
  sourceName: string
): { listings: ParsedPartsListing[]; nextPageUrl: string | null } {
  const $ = cheerio.load(html);
  const listings: ParsedPartsListing[] = [];

  $("div.listview-item").each((i, el) => {
    try {
      const $item = $(el);

      const manufacturer = $item.find(".new-lfz-description h2 strong").text().trim();
      const model = $item.find(".new-lfz-description h3 strong").text().trim();
      const title = [manufacturer, model].filter(Boolean).join(" ").trim();
      if (!title || title.length < 3) return;

      const detailLink = $item.find(".new-lfz-description h2 a").attr("href")
        ?? $item.find("a[href][title]").first().attr("href");
      const detailUrl = detailLink
        ? (detailLink.startsWith("http") ? detailLink : `https://www.aeromarkt.net${detailLink}`)
        : pageUrl;

      const priceText = $item.find("p.price span").text().trim();
      let price: number | null = null;
      const priceMatch = priceText.match(/([\d.,]+)\s*€/) ?? priceText.match(/€\s*([\d.,]+)/);
      if (priceMatch) {
        price = parseFloat(priceMatch[1].replace(/\./g, "").replace(",", "."));
        if (isNaN(price)) price = null;
      }

      const urlLower = pageUrl.toLowerCase();
      let category: "avionics" | "engines" | "rescue" | "miscellaneous" = "miscellaneous";
      if (urlLower.includes("avionik") || urlLower.includes("instrumente")) category = "avionics";
      else if (urlLower.includes("triebwerk")) category = "engines";

      const images: string[] = [];
      $item.find("img.img-fluid").each((_, img) => {
        const src = $(img).attr("src");
        if (src && !src.includes("no_image") && !src.includes("banner") && !src.includes("logo")) {
          const absoluteUrl = src.startsWith("http") ? src : `https://www.aeromarkt.net${src}`;
          images.push(absoluteUrl);
        }
      });

      listings.push({
        sourceId: detailUrl,
        sourceUrl: detailUrl,
        sourceName,
        postedDate: null,
        title,
        description: title,
        category,
        totalTime: null,
        condition: null,
        price,
        priceNegotiable: price === null,
        vatIncluded: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        imageUrls: images,
        location: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse aeromarkt parts block ${i}`, { pageUrl, error: msg });
    }
  });

  let nextPageUrl: string | null = null;
  const nextLink = $("li.page-next a.page-link").attr("href");
  if (nextLink) {
    const base = new URL(pageUrl);
    if (nextLink.startsWith("http")) {
      nextPageUrl = nextLink;
    } else if (nextLink.startsWith("?")) {
      nextPageUrl = `${base.origin}${base.pathname}${nextLink}`;
    } else {
      nextPageUrl = `${base.origin}${nextLink}`;
    }
  }

  logger.info("Parsed aeromarkt parts page", {
    pageUrl,
    listings: listings.length,
    hasNext: !!nextPageUrl,
  });

  return { listings, nextPageUrl };
}

/**
 * Parse a single aeromarkt.net aircraft detail page.
 * Returns enriched fields: TTAF, engine hours, cycles, annual inspection, location, engine.
 * Merges into an existing ParsedAircraftListing (partial update pattern).
 */
export function parseAeromarktAircraftDetail(
  html: string,
  pageUrl: string,
  existing: ParsedAircraftListing
): ParsedAircraftListing {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  const parseNum = (s: string) => {
    const n = parseFloat(s.replace(/\./g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  };

  // TTAF / Betriebsstunden
  let totalTime = existing.totalTime;
  const ttMatch = text.match(/(?:Betriebsstunden|TTAF|TT(?:AF)?|Flugstunden)[:\s]*([\d.,]+)/i);
  if (ttMatch) totalTime = parseNum(ttMatch[1]);

  // Engine hours / Motorstunden
  let engineHours = existing.engineHours;
  const ehMatch = text.match(/(?:Motorstunden|TTSN|TTE|Motorbetriebs)[:\s]*([\d.,]+)/i);
  if (ehMatch) engineHours = parseNum(ehMatch[1]);

  // Cycles / Landungen
  let cycles = existing.cycles;
  const cyclesMatch = text.match(/(?:Landungen|LDG|Ldg\.?|Zyklen)[:\s]*([\d.,]+)/i);
  if (cyclesMatch) cycles = parseInt(cyclesMatch[1].replace(/\./g, ""), 10) || null;

  // Annual inspection — Jahresnachprüfung, JNP, TP, HU
  let annualInspection = existing.annualInspection;
  const annualMatch = text.match(/(?:Jahresnachpr[üu]fung|JNP|TP|HU)[:\s]*([\d./]+(?:\s*\d{2,4})?)/i);
  if (annualMatch) annualInspection = annualMatch[1].trim();

  // Engine description
  let engine = existing.engine;
  const engineDescMatch = text.match(/(?:Triebwerk|Motortyp|Motor)[:\s]*([^;\n,.]{5,60})/i);
  if (engineDescMatch) engine = engineDescMatch[1].trim();

  // Registration / Kennzeichen
  let registration = existing.registration;
  const regAeroMatch = text.match(/(?:Kennzeichen|Kennz\.?)[:\s]*([A-Z]{1,2}-[A-Z0-9]{2,5})/i)
    ?? text.match(/\b([A-Z]{1,2}-[A-Z0-9]{2,5})\b/);
  if (regAeroMatch) registration = regAeroMatch[1];

  // Serial number / Werk-Nr.
  let serialNumber = existing.serialNumber;
  const serialAeroMatch = text.match(/(?:Werk[- ]?Nr\.?|S\/N|Seriennummer)[:\s]*([A-Z0-9][\w-]{1,20})/i);
  if (serialAeroMatch) serialNumber = serialAeroMatch[1].trim();

  // Airworthy
  let airworthy = existing.airworthy;
  if (/nicht\s*(?:luft|verkehrs)tüchtig/i.test(text)) airworthy = false;
  else if (/(?:luft|verkehrs)tüchtig(?!\s*zeugnis)|LTB\s+vorhanden|airworthy/i.test(text)) airworthy = true;

  // Avionics free text
  let avionicsText = existing.avionicsText;
  const AVIONICS_KW = ['GPS', 'Transponder', 'Funk', 'VOR', 'ILS', 'ADS-B', 'FLARM',
    'Autopilot', 'Garmin', 'Dynon', 'Becker', 'Trig', 'Bendix', 'King',
    'SkyDemon', 'SkyView', 'XPNDR', 'Mode-S', 'Mode-C', 'TCAS'];
  const avAeroLines: string[] = [];
  for (const seg of text.split(/[•\n]/)) {
    const s = seg.trim();
    if (s.length > 2 && s.length < 200 && AVIONICS_KW.some(k => s.includes(k))) {
      avAeroLines.push(s);
    }
  }
  if (avAeroLines.length > 0) avionicsText = avAeroLines.join('; ');

  // Country from ICAO prefix
  let country = existing.country;
  const icaoCountryMatch = text.match(/\b(ED[A-Z]{2}|LO[A-Z]{2}|LS[A-Z]{2}|EG[A-Z]{2}|LF[A-Z]{2}|EB[A-Z]{2}|LP[A-Z]{2}|LE[A-Z]{2}|LK[A-Z]{2}|EP[A-Z]{2}|EH[A-Z]{2})\b/);
  if (icaoCountryMatch) {
    const prefix = icaoCountryMatch[1].substring(0, 2);
    const ICAO_TO_COUNTRY: Record<string, string> = {
      ED: 'Germany', LO: 'Austria', LS: 'Switzerland',
      EG: 'United Kingdom', LF: 'France', EB: 'Belgium',
      LP: 'Portugal', LE: 'Spain', LK: 'Czech Republic',
      EP: 'Poland', EH: 'Netherlands',
    };
    country = ICAO_TO_COUNTRY[prefix] ?? null;
  }

  // Location
  let location = existing.location;
  const locMatch = text.match(/(?:Standort|Heimatflugplatz)[:\s]*([^\n;,]{3,60})/i);
  if (locMatch) location = locMatch[1].trim();

  // Images from detail page (may have more than index page)
  const detailImages: string[] = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src");
    if (src && !src.includes("logo") && !src.includes("icon") && !src.includes("no_image") && !src.includes("banner")) {
      const abs = src.startsWith("http") ? src : `https://www.aeromarkt.net${src.startsWith("/") ? "" : "/"}${src}`;
      detailImages.push(abs);
    }
  });

  return {
    ...existing,
    sourceUrl: pageUrl,
    totalTime: totalTime ?? existing.totalTime,
    engineHours: engineHours ?? existing.engineHours,
    cycles: cycles ?? existing.cycles,
    annualInspection: annualInspection ?? existing.annualInspection,
    engine: engine ?? existing.engine,
    location: location ?? existing.location,
    registration: registration ?? existing.registration,
    serialNumber: serialNumber ?? existing.serialNumber,
    airworthy: airworthy ?? existing.airworthy,
    avionicsText: avionicsText ?? existing.avionicsText,
    country: country ?? existing.country,
    imageUrls: detailImages.length > existing.imageUrls.length ? detailImages : existing.imageUrls,
  };
}
