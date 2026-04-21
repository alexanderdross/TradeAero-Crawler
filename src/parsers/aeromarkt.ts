import * as cheerio from "cheerio";
import { logger } from "../utils/logger.js";
import { extractContact } from "./shared.js";
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

      // Card-level contact is best-effort (detail page is authoritative).
      const cardContact = extractContact($item.html() ?? "", cardText);

      // Extract city and ICAO from location string: "München (EDDM)", "Strausberg/EDAY"
      let cityCard: string | null = null;
      let icaoCard: string | null = null;
      if (location) {
        const icaoParenMatch = location.match(/\(([A-Z]{4})\)/);
        if (icaoParenMatch) {
          icaoCard = icaoParenMatch[1];
          cityCard = location.replace(/\s*\([A-Z]{4}\)/, "").trim().split(/[/,]/)[0].trim() || null;
        } else {
          cityCard = location.split(/[/(,]/)[0].trim() || null;
        }
      }

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
        city: cityCard,
        airfieldName: null,
        icaoCode: icaoCard,
        // Best-effort card-level contact extraction. Most fields on
        // aeromarkt's index view don't include seller contact info —
        // those come from the detail page, filled later by
        // parseAeromarktAircraftDetail(). But if the card does include
        // a mailto/[at]-obfuscated address we pick it up here.
        contactName: cardContact.name,
        contactEmail: cardContact.email,
        contactPhone: cardContact.phone,
        imageUrls: images,
        registration: null,
        serialNumber: null,
        airworthy: null,
        avionicsText: null,
        country: null,
        emptyWeight: null,
        maxTakeoffWeight: null,
        fuelCapacity: null,
        fuelType: null,
        cruiseSpeed: null,
        maxSpeed: null,
        maxRange: null,
        serviceCeiling: null,
        climbRate: null,
        fuelConsumption: null,
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

      // Best-effort contact extraction on the parts card. Most aeromarkt
      // parts cards lack seller contact info at index level; when it's
      // absent we leave null so the claim-invite cron skips this listing
      // rather than sending a blank email.
      const partsContact = extractContact($item.html() ?? "", $item.text());

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
        contactName: partsContact.name,
        contactEmail: partsContact.email,
        contactPhone: partsContact.phone,
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
 * Extract accordion / collapsible sections from an aeromarkt detail page.
 * Tries Bootstrap 5 accordion (Shopware 6 default), then falls back to
 * heading-based detection. Returns a Map of lowercase section name → content text.
 *
 * Accordion sections found on aeromarkt listings:
 *   "Exterior"            — equipment/avionics items
 *   "Avionik & Instrumente" — avionics breakdown
 *   "Interior"            — cabin/seating description
 *   "Sonstige Informationen" — main description + specs (TTAF, engine, etc.)
 */
function extractAccordionSections(
  $: cheerio.CheerioAPI,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root: cheerio.Cheerio<any>
): Map<string, string> {
  const sections = new Map<string, string>();

  // Strategy 1: Bootstrap 5 / Shopware 6 accordion (.accordion-item)
  root.find(".accordion-item").each((_, el) => {
    const header = $(el)
      .find(".accordion-button, .accordion-header button, .accordion-header h3, .accordion-header h4, .accordion-header .h5")
      .first()
      .text()
      .trim();
    const body = $(el)
      .find(".accordion-body, .accordion-collapse")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (header && body.length > 5) {
      sections.set(header.toLowerCase(), body);
    }
  });

  if (sections.size > 0) return sections;

  // Strategy 2: data-bs-toggle/data-toggle collapse pattern
  root.find("[data-bs-toggle='collapse'], [data-toggle='collapse']").each((_, el) => {
    const header = $(el).text().trim();
    const targetSel = $(el).attr("data-bs-target") ?? $(el).attr("href") ?? "";
    if (!header || !targetSel.startsWith("#")) return;
    const body = root.find(targetSel).text().replace(/\s+/g, " ").trim();
    if (body.length > 5) sections.set(header.toLowerCase(), body);
  });

  if (sections.size > 0) return sections;

  // Strategy 3: HTML5 <details>/<summary>
  root.find("details").each((_, el) => {
    const header = $(el).find("summary").first().text().trim();
    const body = $(el).clone().find("summary").remove().end().text().replace(/\s+/g, " ").trim();
    if (header && body.length > 5) sections.set(header.toLowerCase(), body);
  });

  if (sections.size > 0) return sections;

  // Strategy 4: generic card-header / panel-heading followed by sibling content
  root.find(".card-header, .panel-heading, .collapsible-header").each((_, el) => {
    const header = $(el).text().trim();
    const body = $(el).next(".card-body, .panel-body, .collapsible-body, .collapse")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (header && body.length > 5) sections.set(header.toLowerCase(), body);
  });

  return sections;
}

/**
 * Parse a single aeromarkt.net aircraft detail page.
 * Extracts structured data from accordion sections (Exterior, Avionik & Instrumente,
 * Interior, Sonstige Informationen) plus regex fallbacks for all spec fields.
 * Merges into an existing ParsedAircraftListing (partial update pattern).
 */
export function parseAeromarktAircraftDetail(
  html: string,
  pageUrl: string,
  existing: ParsedAircraftListing
): ParsedAircraftListing {
  const $ = cheerio.load(html);
  // Scope to main content area — avoids bleeding from sidebar/related listings
  const mainContent = $("main, .cms-page, .container--main, #content, article").first();
  const root = mainContent.length ? mainContent : $("body");
  const text = root.text().replace(/\s+/g, " ");

  // ── Extract named accordion sections ──────────────────────────────────────
  const sections = extractAccordionSections($, root);

  // Section aliases (German/English variants seen on aeromarkt)
  const exteriorText   = sections.get("exterior") ?? sections.get("außen") ?? sections.get("aussenbereich") ?? "";
  const avionikText    = sections.get("avionik & instrumente") ?? sections.get("avionik") ?? sections.get("instruments") ?? "";
  const interiorText   = sections.get("interior") ?? sections.get("innen") ?? sections.get("innenausstattung") ?? "";
  const sonstigeText   = sections.get("sonstige informationen") ?? sections.get("sonstige") ?? sections.get("additional information") ?? "";

  // Prefer the accordion "Sonstige Informationen" content as the primary spec-scan target,
  // falling back to the full page text if the section wasn't found.
  const specText = sonstigeText.length > 50 ? sonstigeText : text;

  const parseNum = (s: string) => {
    const n = parseFloat(s.replace(/\./g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  };

  // ── Description ───────────────────────────────────────────────────────────
  // Use accordion "Sonstige Informationen" content as the real description when available.
  // It contains the seller's free-text description of the aircraft (damage history, hangared,
  // engine details, etc.) which is far more useful than the generated placeholder.
  let description = existing.description;
  if (sonstigeText.length > 50) {
    // Prepend interior details if available
    const combinedDesc = interiorText.length > 20
      ? `${sonstigeText} Interior: ${interiorText}`
      : sonstigeText;
    // Only update if the new content is substantially richer than what we have
    if (combinedDesc.length > (description?.length ?? 0)) {
      description = combinedDesc;
    }
  } else if (interiorText.length > 20 && !description?.includes(interiorText.slice(0, 30))) {
    description = description ? `${description} ${interiorText}` : interiorText;
  }

  // ── Avionics — accordion-aware extraction ──────────────────────────────
  // "Exterior" accordion contains the full equipment list on aeromarkt.
  // "Avionik & Instrumente" has the same or a subset, organized by type.
  // We merge both so the classifier in db/aircraft.ts has maximum signal.
  let avionicsText = existing.avionicsText;
  const avionicsSections = [exteriorText, avionikText].filter(s => s.length > 10);
  if (avionicsSections.length > 0) {
    // Split each section into individual item lines and deduplicate
    const seenItems = new Set<string>();
    const avItems: string[] = [];
    for (const section of avionicsSections) {
      // Items are separated by sentence boundaries or newline markers in the collapsed text
      for (const item of section.split(/(?<=[a-zA-Z0-9])\s{2,}|[•·-]\s*/)) {
        const s = item.trim();
        if (s.length > 3 && s.length < 300 && !seenItems.has(s.toLowerCase())) {
          seenItems.add(s.toLowerCase());
          avItems.push(s);
        }
      }
    }
    if (avItems.length > 0) avionicsText = avItems.join("; ");
  }
  // Fallback: keyword scan on full page text (original logic)
  if (!avionicsText || avionicsText === existing.avionicsText) {
    const AVIONICS_KW = ['GPS', 'Transponder', 'Funk', 'VOR', 'ILS', 'ADS-B', 'FLARM',
      'Autopilot', 'Garmin', 'Dynon', 'Becker', 'Trig', 'Bendix', 'King',
      'SkyDemon', 'SkyView', 'XPNDR', 'Mode-S', 'Mode-C', 'TCAS', 'Stormscope'];
    const avAeroLines: string[] = [];
    for (const seg of text.split(/[•\n]/)) {
      const s = seg.trim();
      if (s.length > 2 && s.length < 200 && AVIONICS_KW.some(k => s.includes(k))) {
        avAeroLines.push(s);
      }
    }
    if (avAeroLines.length > 0) avionicsText = avAeroLines.join('; ');
  }

  // ── Spec fields — prefer scoped specText (Sonstige Informationen), fall back to full text ──

  // TTAF / Betriebsstunden / Total Time
  let totalTime = existing.totalTime;
  const ttMatch = specText.match(/(?:Total\s*Time|Betriebsstunden|TTAF|TT(?:AF)?|Flugstunden|time\s+state\s+Airframe)[:\s]*([\d.,]+)/i)
    ?? text.match(/(?:Total\s*Time|Betriebsstunden|TTAF|TT(?:AF)?|Flugstunden)[:\s]*([\d.,]+)/i);
  if (ttMatch) totalTime = parseNum(ttMatch[1]);

  // Engine hours / Motorstunden
  let engineHours = existing.engineHours;
  const ehMatch = specText.match(/TT[:\s]*([\d.,]+)\s*hours?/i)
    ?? specText.match(/(?:Motorstunden|TTSN|TTE|Motorbetriebs|Engine\s+Hours)[:\s]*([\d.,]+)/i)
    ?? text.match(/(?:Motorstunden|TTSN|TTE|Motorbetriebs)[:\s]*([\d.,]+)/i);
  if (ehMatch) engineHours = parseNum(ehMatch[1]);

  // Cycles / Landungen
  let cycles = existing.cycles;
  const cyclesMatch = specText.match(/(?:Landungen|LDG|Ldg\.?|Zyklen|Landings)[:\s]*([\d.,]+)/i)
    ?? text.match(/(?:Landungen|LDG|Ldg\.?|Zyklen)[:\s]*([\d.,]+)/i);
  if (cyclesMatch) cycles = parseInt(cyclesMatch[1].replace(/\./g, ""), 10) || null;

  // Annual inspection — Jahresnachprüfung, JNP, TP, HU, Annual
  let annualInspection = existing.annualInspection;
  const annualMatch = specText.match(/(?:Jahresnachpr[üu]fung|JNP|Annual\s+Inspection|TP|HU)[:\s]*([\w\s./]+?\d{4})/i)
    ?? text.match(/(?:Jahresnachpr[üu]fung|JNP|TP|HU)[:\s]*([\d./]+(?:\s*\d{2,4})?)/i);
  if (annualMatch) annualInspection = annualMatch[1].trim();

  // Engine description — prefer "Engines:" block in Sonstige Informationen
  let engine = existing.engine;
  const engineBlockMatch = specText.match(/Engines?[:\s]*\n?\s*([^\n;]{5,80})/i);
  if (engineBlockMatch) {
    engine = engineBlockMatch[1].trim();
  } else {
    const engineDescMatch = specText.match(/(?:Triebwerk|Motortyp|Motor)[:\s]*([^;\n,.]{5,60})/i)
      ?? text.match(/(?:Triebwerk|Motortyp)\s*:\s*([^;\n,.]{5,60})/i);
    if (engineDescMatch) engine = engineDescMatch[1].trim();
  }

  // Registration / Kennzeichen
  let registration = existing.registration;
  const regAeroMatch = text.match(/(?:Kennzeichen|Kennz\.?)[:\s]*([A-Z]{1,2}-[A-Z0-9]{2,5})/i)
    ?? text.match(/\b([A-Z]{1,2}-[A-Z0-9]{2,5})\b/);
  if (regAeroMatch) registration = regAeroMatch[1];

  // Serial number / Werk-Nr. / S/N
  let serialNumber = existing.serialNumber;
  const serialAeroMatch = specText.match(/(?:Werk[- ]?Nr\.?|S\/N|Seriennummer|Serial\s*Number)[:\s]*([A-Z0-9][\w-]{1,20})/i)
    ?? text.match(/(?:Werk[- ]?Nr\.?|S\/N|Seriennummer)[:\s]*([A-Z0-9][\w-]{1,20})/i);
  if (serialAeroMatch) serialNumber = serialAeroMatch[1].trim();

  // Airworthy
  let airworthy = existing.airworthy;
  if (/nicht\s*(?:luft|verkehrs)tüchtig/i.test(text)) airworthy = false;
  else if (/(?:luft|verkehrs)tüchtig(?!\s*zeugnis)|LTB\s+vorhanden|airworthy/i.test(text)) airworthy = true;

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

  // Parse city and ICAO from location: "München (EDDM)", "Strausberg EDAY"
  let city = existing.city;
  let icaoCode = existing.icaoCode;
  const locStr = location ?? "";
  const icaoParenMatchDetail = locStr.match(/\(([A-Z]{4})\)/);
  if (icaoParenMatchDetail) {
    icaoCode = icaoParenMatchDetail[1];
    city = locStr.replace(/\s*\([A-Z]{4}\)/, "").trim().split(/[/,]/)[0].trim() || city;
  } else if (locStr) {
    // Try slash notation: "Strausberg/EDAY"
    const slashIcaoDetailMatch = locStr.match(/\/([A-Z]{4})$/);
    if (slashIcaoDetailMatch) {
      icaoCode = slashIcaoDetailMatch[1];
      city = locStr.replace(/\/[A-Z]{4}$/, "").trim() || city;
    } else {
      // Simple location — take first part before any separator
      const simplCity = locStr.split(/[/(,]/)[0].trim();
      if (simplCity && simplCity.length >= 2) city = simplCity;
    }
  }
  // Fallback: scan full text for ICAO codes
  if (!icaoCode) {
    const icaoDetailFallback = text.match(/\b((?:ED|LO|LS|EG|LF|EB|LP|LE|LK|EP|EH|LI|EK|ES|EN|EF)[A-Z]{2})\b/);
    if (icaoDetailFallback) icaoCode = icaoDetailFallback[1];
  }

  // Empty weight / Leergewicht
  let emptyWeight = existing.emptyWeight;
  const ewMatch = specText.match(/(?:Leergewicht|Leermasse|Empty\s+Weight)[:\s]*([\d.,]+)\s*(?:kg|lbs?)/i)
    ?? text.match(/(?:Leergewicht|Leermasse)[:\s]*([\d.,]+)\s*kg/i);
  if (ewMatch) emptyWeight = parseNum(ewMatch[1]);

  // Max takeoff weight / MTOW
  let maxTakeoffWeight = existing.maxTakeoffWeight;
  const mtowMatch = specText.match(/(?:MTOW|Abflugmasse|Abfluggewicht|MAUW|Max.*Takeoff)[:\s]*([\d.,]+)\s*(?:kg|lbs?)/i)
    ?? text.match(/(?:MTOW|Abflugmasse|Abfluggewicht|MAUW)[:\s]*([\d.,]+)\s*kg/i);
  if (mtowMatch) maxTakeoffWeight = parseNum(mtowMatch[1]);

  // Fuel capacity / Tankinhalt
  let fuelCapacity = existing.fuelCapacity;
  const fuelCapMatch = specText.match(/(?:Tankinhalt|Kraftstoffmenge|Tank\s+capacity|Fuel\s+Capacity)[:\s]*([\d.,]+)\s*(?:[lLgal])/i)
    ?? text.match(/(?:Tankinhalt|Kraftstoffmenge|Tank)[:\s]*([\d.,]+)\s*[lL]/i);
  if (fuelCapMatch) fuelCapacity = parseNum(fuelCapMatch[1]);

  // Fuel type
  let fuelType = existing.fuelType;
  if (/MOGAS|Normalbenzin|Super(?!flug)/i.test(text)) fuelType = "MOGAS";
  else if (/AVGAS|100LL/i.test(text)) fuelType = "AVGAS";
  else if (/Jet.?A|Kerosin|Diesel/i.test(text)) fuelType = "Jet-A";

  // Cruise speed / Reisegeschwindigkeit / Cruise at X Knots
  let cruiseSpeed = existing.cruiseSpeed;
  const cruiseMatch = specText.match(/[Cc]ruise\s+at\s+([\d.,]+)\s*[Kk]nots?/i)
    ?? specText.match(/(?:Reisegeschwindigkeit|Reise(?:geschw\.?)?|Vcr)[:\s]*([\d.,]+)\s*(?:km\/h|kts?)/i)
    ?? text.match(/(?:Reisegeschwindigkeit|Reise(?:geschw\.?)?|Vcr)[:\s]*([\d.,]+)\s*(?:km\/h|kts?)/i);
  if (cruiseMatch) cruiseSpeed = parseNum(cruiseMatch[1]);

  // Max speed / Vne / Höchstgeschwindigkeit
  let maxSpeed = existing.maxSpeed;
  const maxSpdMatch = specText.match(/(?:Höchstgeschwindigkeit|Vne|Vmax|Max.*[Ss]peed)[:\s]*([\d.,]+)\s*(?:km\/h|kts?)/i)
    ?? text.match(/(?:Höchstgeschwindigkeit|Vne|Vmax)[:\s]*([\d.,]+)\s*(?:km\/h|kts?)/i);
  if (maxSpdMatch) maxSpeed = parseNum(maxSpdMatch[1]);

  // Range / Reichweite
  let maxRange = existing.maxRange;
  const rangeMatch = specText.match(/(?:Reichweite|Range)[:\s]*([\d.,]+)\s*(?:km|nm|NM)/i)
    ?? text.match(/(?:Reichweite|Range)[:\s]*([\d.,]+)\s*(?:km|nm)/i);
  if (rangeMatch) maxRange = parseNum(rangeMatch[1]);

  // Service ceiling / Gipfelhöhe
  let serviceCeiling = existing.serviceCeiling;
  const ceilMatch = specText.match(/(?:Gipfelhöhe|Dienstgipfelhöhe|Betriebshöhe|Service\s+Ceiling)[:\s]*([\d.,]+)\s*(?:m|ft)/i)
    ?? text.match(/(?:Gipfelhöhe|Dienstgipfelhöhe|Betriebshöhe)[:\s]*([\d.,]+)\s*(?:m|ft)/i);
  if (ceilMatch) serviceCeiling = parseNum(ceilMatch[1]);

  // Climb rate / Steigleistung
  let climbRate = existing.climbRate;
  const climbMatch = specText.match(/(?:Steigleistung|Steigrate|Climb\s+Rate)[:\s]*([\d.,]+)\s*(?:m\/s|ft\/min|fpm)/i)
    ?? text.match(/(?:Steigleistung|Steigrate)[:\s]*([\d.,]+)\s*(?:m\/s|ft\/min)/i);
  if (climbMatch) climbRate = parseNum(climbMatch[1]);

  // Fuel consumption / Verbrauch
  let fuelConsumption = existing.fuelConsumption;
  const consumMatch = specText.match(/(?:Verbrauch|Kraftstoffverbrauch|Fuel\s+Consumption)[:\s]*([\d.,]+)\s*(?:L\/h|l\/h|ltr\/h|gal\/h)/i)
    ?? text.match(/(?:Verbrauch|Kraftstoffverbrauch)[:\s]*([\d.,]+)\s*(?:L\/h|l\/h|ltr\/h)/i);
  if (consumMatch) fuelConsumption = parseNum(consumMatch[1]);

  // Images — scoped to the main product gallery only to avoid sidebar/related-listing pollution.
  // Shopware 6 renders "similar listings" carousels with images from other aircraft on the same page.
  // We only want images from the primary gallery element, not from navigation or recommendations.
  const detailImages: string[] = [];
  const galleryRoot = $(
    ".product-image-gallery, .cms-element-product-detail-gallery, .gallery-slider, " +
    ".product-detail__media, .product-media-gallery, main .gallery, " +
    ".cms-element-image-gallery, .cms-block-gallery, .product-images"
  );
  // Only use gallery-scoped images if we found the gallery container
  const imgScope = galleryRoot.length ? galleryRoot : null;
  if (imgScope) {
    imgScope.find("img").each((_, el) => {
      // Only use src (not data-src — lazy-loaded sidebar images use data-src)
      const src = $(el).attr("src");
      if (
        src &&
        !src.includes("logo") &&
        !src.includes("icon") &&
        !src.includes("no_image") &&
        !src.includes("banner") &&
        !src.includes("placeholder")
      ) {
        const abs = src.startsWith("http") ? src : `https://www.aeromarkt.net${src.startsWith("/") ? "" : "/"}${src}`;
        detailImages.push(abs);
      }
    });
  }
  // Use detail images only if the gallery was found AND has images;
  // otherwise keep index-page thumbnails (which are reliably scoped per-listing)
  const finalImages = detailImages.length > 0 ? detailImages : existing.imageUrls;

  // Contact details live on the detail page — extract here so the
  // cold-email claim-invite flow has contact_email / phone / name to
  // work with. Shared helper handles mailto:, [at] obfuscation, and
  // the standard German phone-label patterns.
  const contact = extractContact(html, text);

  return {
    ...existing,
    sourceUrl: pageUrl,
    description: description ?? existing.description,
    totalTime: totalTime ?? existing.totalTime,
    engineHours: engineHours ?? existing.engineHours,
    cycles: cycles ?? existing.cycles,
    annualInspection: annualInspection ?? existing.annualInspection,
    engine: engine ?? existing.engine,
    location: location ?? existing.location,
    city: city ?? existing.city,
    icaoCode: icaoCode ?? existing.icaoCode,
    registration: registration ?? existing.registration,
    serialNumber: serialNumber ?? existing.serialNumber,
    airworthy: airworthy ?? existing.airworthy,
    avionicsText: avionicsText ?? existing.avionicsText,
    country: country ?? existing.country,
    emptyWeight: emptyWeight ?? existing.emptyWeight,
    maxTakeoffWeight: maxTakeoffWeight ?? existing.maxTakeoffWeight,
    fuelCapacity: fuelCapacity ?? existing.fuelCapacity,
    fuelType: fuelType ?? existing.fuelType,
    cruiseSpeed: cruiseSpeed ?? existing.cruiseSpeed,
    maxSpeed: maxSpeed ?? existing.maxSpeed,
    maxRange: maxRange ?? existing.maxRange,
    serviceCeiling: serviceCeiling ?? existing.serviceCeiling,
    climbRate: climbRate ?? existing.climbRate,
    fuelConsumption: fuelConsumption ?? existing.fuelConsumption,
    contactName: contact.name ?? existing.contactName,
    contactEmail: contact.email ?? existing.contactEmail,
    contactPhone: contact.phone ?? existing.contactPhone,
    imageUrls: finalImages,
  };
}
