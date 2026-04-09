-- Cleanup: fix garbage city values in aircraft_listings
-- Run in Supabase SQL Editor
-- Created: 2026-04-09

-- 1. Null out city values that contain description text / garbage
UPDATE aircraft_listings SET city = NULL WHERE city IS NOT NULL AND (
  -- Contains numbers (postal codes, years, prices)
  city ~ '\d'
  -- Too long to be a city name
  OR length(city) > 35
  -- More than 4 words (likely a sentence fragment)
  OR array_length(string_to_array(city, ' '), 1) > 4
  -- Starts with lowercase (not a proper noun)
  OR city ~ '^[a-zäöü]'
  -- Contains known junk keywords
  OR lower(city) ~ '\m(verkauf|privatverkauf|biete|angeboten|baujahr|motor|rotax|stunden|flugstunden|einsitzer|doppelsitzer|ultraleicht|cessna|piper|beechcraft|fallen|defekt|unfall|telefon|email|kontakt|hersteller|southwest|northwest|northeast|southeast|flugplatz|flughafen|airport|hangar|lagerung|werkstatt|museum)\M'
  -- Contains country names (should be in country column, not city)
  OR lower(city) ~ '\m(deutschland|germany|frankreich|france|italien|italy|österreich|austria|schweiz|switzerland|niederlande|netherlands|polen|poland|ungarn|hungary|spanien|spain|dänemark|denmark|belgien|belgium|brasilien|brazil)\M'
);

-- 2. Strip ICAO codes from city: "München EDDM" → "München"
UPDATE aircraft_listings SET city = regexp_replace(city, '\s+[A-Z]{4}$', '')
WHERE city ~ '\s+[A-Z]{4}$' AND city ~ '\s+(ED|ET|LO|LS|LF|LE|LI|EH|EB|EP|LK|ES|EN|EK|LG|LT)';

-- 3. Strip "Flugplatz/Flughafen" prefix
UPDATE aircraft_listings SET city = regexp_replace(city, '^(Flugplatz|Flughafen|Airport|Airfield)\s+', '', 'i')
WHERE city ~* '^(Flugplatz|Flughafen|Airport|Airfield)\s+';

-- 4. Strip postal codes: "86150 Augsburg" → "Augsburg"
UPDATE aircraft_listings SET city = regexp_replace(city, '^\d{4,5}\s+', '')
WHERE city ~ '^\d{4,5}\s+';

-- 5. Strip ICAO in parentheses: "München (EDDM)" → "München"
UPDATE aircraft_listings SET city = regexp_replace(city, '\s*\([A-Z]{4}\)', '')
WHERE city ~ '\([A-Z]{4}\)';

-- 6. Strip everything after comma: "Colnrade, 15NM..." → "Colnrade"
UPDATE aircraft_listings SET city = split_part(city, ',', 1)
WHERE city LIKE '%,%';

-- 7. Trim whitespace
UPDATE aircraft_listings SET city = trim(city) WHERE city IS NOT NULL;

-- 8. Null out empty strings
UPDATE aircraft_listings SET city = NULL WHERE city = '' OR city = ' ';

-- 9. Verify results
SELECT city, count(*) FROM aircraft_listings
WHERE city IS NOT NULL AND is_external = true
GROUP BY city ORDER BY count(*) DESC LIMIT 30;
