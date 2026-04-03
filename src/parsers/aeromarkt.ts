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

      listings.push({
        sourceId: detailUrl,
        sourceUrl: detailUrl,
        sourceName,
        postedDate: null,
        title,
        description: buildDescription(manufacturer, model, year, price, priceNegotiable),
        year,
        engine: null,
        totalTime: null,
        mtow: null,
        rescueSystem: null,
        annualInspection: null,
        dulvRef: null,
        price,
        priceNegotiable,
        location: null,
        city: null,
        airfieldName: null,
        icaoCode: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        imageUrls: images,
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
