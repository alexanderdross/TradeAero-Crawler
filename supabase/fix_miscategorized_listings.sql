-- Fix miscategorized aircraft listings using aircraft_reference_specs as source of truth.
--
-- Problem: Listings from helmuts-ul-seiten.de were ALL categorized as
-- "Ultralight / Light Sport Aircraft (LSA)" regardless of actual type,
-- because the old detectCategoryName() matched the domain name.
-- This caused Mooney, Piper, Robin (SEP) and Agusta (Helicopter) to appear
-- on the wrong category pages.
--
-- Solution: Use the aircraft_reference_specs table — it already has the correct
-- category for every known manufacturer. For each miscategorized listing,
-- look up the manufacturer's correct category from reference specs and fix it.
--
-- Run in Supabase SQL Editor. Safe: only updates category_id, no deletions.

-- Preview: show miscategorized listings
SELECT headline,
  (SELECT name FROM aircraft_manufacturers WHERE id = manufacturer_id) AS manufacturer,
  (SELECT name FROM aircraft_categories WHERE id = category_id) AS current_category
FROM aircraft_listings
WHERE is_external = true
  AND category_id IN (
    SELECT id FROM aircraft_categories
    WHERE name IN ('Ultralight / Light Sport Aircraft (LSA)', 'Microlight / Flex-Wing')
  )
  AND manufacturer_id IN (
    SELECT id FROM aircraft_manufacturers
    WHERE LOWER(name) IN (
      SELECT DISTINCT LOWER(manufacturer) FROM aircraft_reference_specs
      WHERE category IS NOT NULL
        AND category NOT IN ('Ultralight / Light Sport Aircraft (LSA)', 'Microlight / Flex-Wing')
    )
  )
ORDER BY manufacturer;

-- Fix Single Engine Piston manufacturers
UPDATE aircraft_listings
SET category_id = (SELECT id FROM aircraft_categories WHERE name = 'Single Engine Piston'),
    updated_at = now()
WHERE is_external = true
  AND category_id IN (SELECT id FROM aircraft_categories WHERE name IN ('Ultralight / Light Sport Aircraft (LSA)', 'Microlight / Flex-Wing'))
  AND manufacturer_id IN (SELECT id FROM aircraft_manufacturers WHERE LOWER(name) IN ('mooney', 'piper', 'siai-marchetti', 'yakovlev', 'scottish aviation'));

-- Fix Robinson helicopters
UPDATE aircraft_listings
SET category_id = (SELECT id FROM aircraft_categories WHERE name = 'Helicopter / Gyrocopter'),
    updated_at = now()
WHERE is_external = true
  AND headline ILIKE 'Robinson R%'
  AND category_id != (SELECT id FROM aircraft_categories WHERE name = 'Helicopter / Gyrocopter');

-- Fix Tecnam P2010 (SEP, not LSA)
UPDATE aircraft_listings
SET category_id = (SELECT id FROM aircraft_categories WHERE name = 'Single Engine Piston'),
    updated_at = now()
WHERE is_external = true
  AND headline ILIKE '%Tecnam P2010%'
  AND category_id IN (SELECT id FROM aircraft_categories WHERE name = 'Ultralight / Light Sport Aircraft (LSA)');

-- Fix Piper PA-23 Apache (MEP)
UPDATE aircraft_listings
SET category_id = (SELECT id FROM aircraft_categories WHERE name = 'Multi Engine Piston'),
    updated_at = now()
WHERE is_external = true
  AND headline ILIKE '%PA-23%';

-- Verify results
SELECT (SELECT name FROM aircraft_categories WHERE id = category_id) AS category,
  COUNT(*) AS listing_count
FROM aircraft_listings
WHERE status = 'active' AND is_external = true
GROUP BY category_id
ORDER BY listing_count DESC;
