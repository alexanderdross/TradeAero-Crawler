-- Fix category mismatches in aircraft_listings and aircraft_reference_specs.
--
-- Problem: The crawler's detectCategoryFromUrlAndTitle() defaults to LSA for
-- listings from helmuts-ul-seiten.de (line 53 in aircraft.ts). When a
-- manufacturer is NOT in aircraft_reference_specs, the ref-spec category
-- lookup returns NULL and the heuristic fallback assigns LSA.
--
-- This migration:
-- 1. Adds legacy/alternate manufacturer entries to aircraft_reference_specs
-- 2. Sets correct categories for those entries
-- 3. Fixes existing miscategorized aircraft_listings using ref specs as truth
--
-- Safe: only updates category fields, no deletions. Idempotent.
-- Run in Supabase SQL Editor.

-- ============================================================================
-- STEP 1: Insert legacy manufacturer entries into aircraft_reference_specs
-- (Agusta, AgustaWestland, Eurocopter, MBB, Aerospatiale)
-- ============================================================================

-- Agusta (pre-2000, before AgustaWestland merger)
INSERT INTO aircraft_reference_specs (manufacturer, model, variant, category)
VALUES
  ('Agusta', 'A109', NULL, 'Helicopter'),
  ('Agusta', 'A119', 'Koala', 'Helicopter'),
  ('Agusta', 'A109', 'Power', 'Helicopter')
ON CONFLICT DO NOTHING;

-- AgustaWestland (2000-2016, before Leonardo rebrand)
INSERT INTO aircraft_reference_specs (manufacturer, model, variant, category)
VALUES
  ('AgustaWestland', 'AW109', NULL, 'Helicopter'),
  ('AgustaWestland', 'AW119', NULL, 'Helicopter'),
  ('AgustaWestland', 'AW139', NULL, 'Helicopter'),
  ('AgustaWestland', 'AW169', NULL, 'Helicopter'),
  ('AgustaWestland', 'AW189', NULL, 'Helicopter')
ON CONFLICT DO NOTHING;

-- Eurocopter (pre-2014, before Airbus Helicopters rebrand)
INSERT INTO aircraft_reference_specs (manufacturer, model, variant, category)
VALUES
  ('Eurocopter', 'EC120', 'Colibri', 'Helicopter'),
  ('Eurocopter', 'EC130', NULL, 'Helicopter'),
  ('Eurocopter', 'EC135', NULL, 'Helicopter'),
  ('Eurocopter', 'EC145', NULL, 'Helicopter'),
  ('Eurocopter', 'EC155', NULL, 'Helicopter'),
  ('Eurocopter', 'AS350', 'Ecureuil', 'Helicopter'),
  ('Eurocopter', 'AS355', NULL, 'Helicopter'),
  ('Eurocopter', 'AS365', 'Dauphin', 'Helicopter'),
  ('Eurocopter', 'BK117', NULL, 'Helicopter')
ON CONFLICT DO NOTHING;

-- MBB (Messerschmitt-Bölkow-Blohm, merged into Eurocopter)
INSERT INTO aircraft_reference_specs (manufacturer, model, variant, category)
VALUES
  ('MBB', 'Bo 105', NULL, 'Helicopter'),
  ('MBB', 'BK 117', NULL, 'Helicopter')
ON CONFLICT DO NOTHING;

-- Aerospatiale (merged into Eurocopter)
INSERT INTO aircraft_reference_specs (manufacturer, model, variant, category)
VALUES
  ('Aerospatiale', 'SA 341', 'Gazelle', 'Helicopter'),
  ('Aerospatiale', 'SA 365', 'Dauphin', 'Helicopter'),
  ('Aerospatiale', 'AS 350', 'Ecureuil', 'Helicopter')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 2: Ensure all helicopter manufacturers have category = 'Helicopter'
-- ============================================================================

UPDATE aircraft_reference_specs SET category = 'Helicopter'
WHERE manufacturer IN (
  'Robinson', 'Airbus Helicopters', 'Bell', 'Leonardo',
  'MD Helicopters', 'Sikorsky', 'Enstrom', 'Guimbal', 'Schweizer', 'Kopter',
  'AutoGyro', 'Magni', 'ELA Aviacion', 'Trendak', 'RotorSchmiede', 'ArrowCopter',
  'Celier',
  -- Legacy names
  'Agusta', 'AgustaWestland', 'Eurocopter', 'MBB', 'Aerospatiale'
)
AND (category IS NULL OR category != 'Helicopter');

-- ============================================================================
-- STEP 3: Fix existing aircraft_listings using reference_specs as truth
-- ============================================================================

-- For each external listing currently in LSA or Microlight categories,
-- check if the manufacturer has a different correct category in reference_specs.
-- This handles ALL manufacturers at once.
UPDATE aircraft_listings al
SET category_id = correct_cat.id,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (rs.manufacturer)
    am.id AS manufacturer_id,
    ac.id,
    ac.name AS category_name,
    rs.manufacturer
  FROM aircraft_reference_specs rs
  JOIN aircraft_manufacturers am ON LOWER(am.name) = LOWER(rs.manufacturer)
  JOIN aircraft_categories ac ON ac.name = rs.category
  WHERE rs.category IS NOT NULL
  GROUP BY rs.manufacturer, am.id, ac.id, ac.name
  ORDER BY rs.manufacturer, COUNT(*) DESC
) correct_cat
WHERE al.manufacturer_id = correct_cat.manufacturer_id
  AND al.is_external = true
  AND al.category_id != correct_cat.id
  -- Only fix listings in likely-wrong categories
  AND al.category_id IN (
    SELECT id FROM aircraft_categories
    WHERE name IN (
      'Light Sport Aircraft',
      'Ultralight / Light Sport Aircraft (LSA)',
      'Microlight / Flex-Wing',
      'Other'
    )
  );

-- Also fix by headline keyword matching for manufacturers not yet in
-- aircraft_manufacturers table (e.g. "Agusta" might not have a manufacturer_id)
UPDATE aircraft_listings
SET category_id = (SELECT id FROM aircraft_categories WHERE name = 'Helicopter' LIMIT 1),
    updated_at = now()
WHERE is_external = true
  AND category_id IN (
    SELECT id FROM aircraft_categories
    WHERE name IN ('Light Sport Aircraft', 'Ultralight / Light Sport Aircraft (LSA)')
  )
  AND (
    headline ILIKE '%agusta%'
    OR headline ILIKE '%agustawestland%'
    OR headline ILIKE '%eurocopter%'
    OR headline ILIKE '%mbb%bo%105%'
    OR headline ILIKE '%aerospatiale%'
  );

-- ============================================================================
-- STEP 4: Verification queries (uncomment to check results)
-- ============================================================================

-- Count listings per category after fix:
-- SELECT ac.name AS category, COUNT(*) AS listing_count
-- FROM aircraft_listings al
-- JOIN aircraft_categories ac ON al.category_id = ac.id
-- WHERE al.status = 'active' AND al.is_external = true
-- GROUP BY ac.name
-- ORDER BY listing_count DESC;

-- Show all Agusta/helicopter-related listings and their categories:
-- SELECT al.headline, am.name AS manufacturer, ac.name AS category
-- FROM aircraft_listings al
-- LEFT JOIN aircraft_manufacturers am ON al.manufacturer_id = am.id
-- JOIN aircraft_categories ac ON al.category_id = ac.id
-- WHERE al.headline ILIKE '%agusta%'
--    OR al.headline ILIKE '%eurocopter%'
--    OR am.name IN ('Agusta', 'AgustaWestland', 'Eurocopter', 'Leonardo', 'Airbus Helicopters')
-- ORDER BY am.name;

-- Remaining LSA listings (should only be genuine UL/microlight):
-- SELECT al.headline, am.name AS manufacturer, ac.name AS category
-- FROM aircraft_listings al
-- LEFT JOIN aircraft_manufacturers am ON al.manufacturer_id = am.id
-- JOIN aircraft_categories ac ON al.category_id = ac.id
-- WHERE ac.name IN ('Light Sport Aircraft', 'Ultralight / Light Sport Aircraft (LSA)')
--   AND al.is_external = true
-- ORDER BY am.name;
