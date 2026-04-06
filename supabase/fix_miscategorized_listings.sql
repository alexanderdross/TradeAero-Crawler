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

-- Fix listings where the manufacturer exists in reference_specs with a different category
-- than what the listing currently has.
-- This handles ALL manufacturers at once (Mooney→SEP, Agusta→Helicopter, etc.)
UPDATE aircraft_listings al
SET category_id = correct_cat.id,
    updated_at = now()
FROM (
  -- For each manufacturer, find the most common category in reference_specs
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
  -- Only fix listings currently in LSA or Microlight (the misassigned categories)
  AND al.category_id IN (
    SELECT id FROM aircraft_categories
    WHERE name IN (
      'Ultralight / Light Sport Aircraft (LSA)',
      'Microlight / Flex-Wing'
    )
  );

-- Verification queries (uncomment to check results):

-- Show what was fixed:
-- SELECT al.headline, am.name AS manufacturer,
--   old_cat.name AS old_category, new_cat.name AS new_category
-- FROM aircraft_listings al
-- JOIN aircraft_manufacturers am ON al.manufacturer_id = am.id
-- JOIN aircraft_categories old_cat ON old_cat.id != al.category_id
-- JOIN aircraft_categories new_cat ON new_cat.id = al.category_id
-- WHERE al.is_external = true
--   AND al.updated_at > now() - interval '5 minutes'
-- ORDER BY am.name;

-- Count listings per category after fix:
-- SELECT ac.name AS category, COUNT(*) AS listing_count
-- FROM aircraft_listings al
-- JOIN aircraft_categories ac ON al.category_id = ac.id
-- WHERE al.status = 'active' AND al.is_external = true
-- GROUP BY ac.name
-- ORDER BY listing_count DESC;

-- Remaining LSA/Microlight listings (should only be genuine UL/microlight now):
-- SELECT al.headline, am.name AS manufacturer, ac.name AS category
-- FROM aircraft_listings al
-- LEFT JOIN aircraft_manufacturers am ON al.manufacturer_id = am.id
-- JOIN aircraft_categories ac ON al.category_id = ac.id
-- WHERE ac.name IN ('Ultralight / Light Sport Aircraft (LSA)', 'Microlight / Flex-Wing')
--   AND al.is_external = true
-- ORDER BY am.name;
