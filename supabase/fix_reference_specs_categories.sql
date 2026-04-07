-- Add new aircraft categories
INSERT INTO public.aircraft_categories (id, name) VALUES (14, 'Glider') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.aircraft_categories (id, name) VALUES (15, 'Microlight / Flex-Wing') ON CONFLICT (id) DO NOTHING;

-- Fix aircraft_reference_specs categories (all were incorrectly set to 'Light Sport Aircraft')
-- Rule: Rotax/Jabiru/ULPower engines → Light Sport Aircraft
--       Lycoming/Continental engines → Single Engine Piston
--       Manufacturer-based for the rest

-- Single Engine Piston manufacturers (Lycoming/Continental engines)
UPDATE public.aircraft_reference_specs SET category = 'Single Engine Piston'
WHERE manufacturer IN (
  'Cessna', 'Piper', 'Beechcraft', 'Mooney', 'Robin', 'Grumman', 'Socata',
  'Jodel', 'Grob', 'Zlin', 'Fuji', 'Commander', 'Lake', 'Bellanca',
  'Stinson', 'Luscombe', 'Aeronca', 'Taylorcraft', 'Globe', 'Ercoupe',
  'Maule', 'Aviat', 'American Champion', 'CubCrafters', 'Extra',
  'Cirrus', 'Diamond'
);

-- Fix Diamond multi-engine models back
UPDATE public.aircraft_reference_specs SET category = 'Multi Engine Piston'
WHERE manufacturer = 'Diamond' AND model IN ('DA42', 'DA62');

-- Fix Diamond motorglider
UPDATE public.aircraft_reference_specs SET category = 'Light Sport Aircraft'
WHERE manufacturer = 'Diamond' AND model = 'HK36';

-- Multi Engine Piston
UPDATE public.aircraft_reference_specs SET category = 'Multi Engine Piston'
WHERE manufacturer IN ('Partenavia', 'Vulcanair')
   OR (manufacturer = 'Piper' AND model IN ('PA-34', 'PA-44', 'PA-23', 'PA-30', 'PA-31', 'PA-31T'))
   OR (manufacturer = 'Beechcraft' AND model IN ('Baron', 'Duchess', 'Travel Air', 'Queen Air'))
   OR (manufacturer = 'Cessna' AND model IN ('310', '340', '402', '414', '303', '320', '335', '401', '421'))
   OR (manufacturer = 'Tecnam' AND model = 'P2006T')
   OR (manufacturer = 'De Havilland' AND model = 'DHC-6');

-- Turboprop
UPDATE public.aircraft_reference_specs SET category = 'Turboprop'
WHERE manufacturer IN ('Daher', 'Pilatus', 'Quest', 'Piaggio', 'Dornier', 'ATR',
  'Pacific Aerospace', 'Short Brothers', 'Epic')
   OR (manufacturer = 'Beechcraft' AND model LIKE 'King Air%')
   OR (manufacturer = 'Beechcraft' AND model = '1900D')
   OR (manufacturer = 'Cessna' AND model IN ('208', '208B', '425', '441'))
   OR (manufacturer = 'Piper' AND model IN ('PA-42', 'M500', 'M600'))
   OR (manufacturer = 'Socata' AND model LIKE 'TBM%');

-- Fix Pilatus PC-24 → Light Jet (not turboprop)
UPDATE public.aircraft_reference_specs SET category = 'Light Jet'
WHERE manufacturer = 'Pilatus' AND model = 'PC-24';

-- Light Jet
UPDATE public.aircraft_reference_specs SET category = 'Light Jet'
WHERE manufacturer IN ('Eclipse', 'HondaJet', 'Nextant')
   OR (manufacturer = 'Cessna' AND model LIKE 'Citation M%')
   OR (manufacturer = 'Cessna' AND model LIKE 'Citation CJ%')
   OR (manufacturer = 'Cessna' AND model = 'Citation Mustang')
   OR (manufacturer = 'Embraer' AND model LIKE 'Phenom%')
   OR (manufacturer = 'Learjet' AND model IN ('45', '75'));

-- Very Light Jet
UPDATE public.aircraft_reference_specs SET category = 'Very Light Jet'
WHERE manufacturer IN ('Stratos')
   OR (manufacturer = 'Eclipse' AND model = '500')
   OR (manufacturer = 'Cirrus' AND model = 'SF50');

-- Mid-Size Jet
UPDATE public.aircraft_reference_specs SET category = 'Mid-Size Jet'
WHERE manufacturer = 'Hawker'
   OR (manufacturer = 'Cessna' AND model IN ('Citation XLS+', 'Citation Latitude', 'Citation Sovereign+', 'Citation Excel'))
   OR (manufacturer = 'Bombardier' AND model LIKE 'Learjet%');

-- Super Mid-Size Jet
UPDATE public.aircraft_reference_specs SET category = 'Super Mid-Size Jet'
WHERE (manufacturer = 'Cessna' AND model IN ('Citation Longitude', 'Citation X+'))
   OR (manufacturer = 'Bombardier' AND model LIKE 'Challenger%')
   OR (manufacturer = 'Embraer' AND model LIKE 'Praetor%')
   OR (manufacturer = 'Gulfstream' AND model = 'G280')
   OR (manufacturer = 'Dassault' AND model LIKE 'Falcon 2000%')
   OR (manufacturer = 'Dassault' AND model LIKE 'Falcon 900%');

-- Heavy Jet
UPDATE public.aircraft_reference_specs SET category = 'Heavy Jet'
WHERE (manufacturer = 'Gulfstream' AND model IN ('G450', 'G500', 'G550', 'G600', 'G650', 'GIV-SP', 'GV'))
   OR (manufacturer = 'Bombardier' AND model LIKE 'Global%')
   OR (manufacturer = 'Dassault' AND model IN ('Falcon 7X', 'Falcon 8X', 'Falcon 6X', 'Falcon 50'));

-- Ultra Long Range
UPDATE public.aircraft_reference_specs SET category = 'Ultra Long Range'
WHERE (manufacturer = 'Gulfstream' AND model = 'G700')
   OR (manufacturer = 'Boeing' AND model = 'BBJ')
   OR (manufacturer = 'Airbus' AND model = 'ACJ319neo')
   OR (manufacturer = 'Embraer' AND model LIKE 'Lineage%')
   OR (manufacturer = 'Embraer' AND model LIKE 'Legacy%');

-- Helicopter (includes legacy brand names: Agusta→Leonardo, Eurocopter→Airbus Helicopters)
UPDATE public.aircraft_reference_specs SET category = 'Helicopter'
WHERE manufacturer IN ('Robinson', 'Airbus Helicopters', 'Bell', 'Leonardo',
  'MD Helicopters', 'Sikorsky', 'Enstrom', 'Guimbal', 'Schweizer', 'Kopter',
  'AutoGyro', 'Magni', 'ELA Aviacion', 'Trendak', 'RotorSchmiede', 'ArrowCopter',
  'Celier',
  'Agusta', 'AgustaWestland', 'Eurocopter', 'MBB', 'Aerospatiale');

-- Other (Experimental, Aerobatic, Warbirds)
UPDATE public.aircraft_reference_specs SET category = 'Other'
WHERE manufacturer IN ('Pitts', 'XtremeAir', 'Sukhoi', 'Yakovlev', 'Cap Aviation',
  'Mudry', 'MXR', 'Nanchang', 'North American', 'Scottish Aviation')
   OR (manufacturer = 'Vans' AND model IS NOT NULL)
   OR (manufacturer = 'Lancair')
   OR (manufacturer = 'Glasair')
   OR (manufacturer = 'Murphy')
   OR (manufacturer = 'Sonex');

-- Trikes / Paramotors → Microlight / Flex-Wing
UPDATE public.aircraft_reference_specs SET category = 'Microlight / Flex-Wing'
WHERE manufacturer IN ('Air Creation', 'P&M Aviation', 'Cosmos', 'Airborne', 'Fresh Breeze');

-- Gliders / Motorgliders → Glider
UPDATE public.aircraft_reference_specs SET category = 'Glider'
WHERE manufacturer IN ('Stemme', 'Schempp-Hirth', 'DG Flugzeugbau')
   OR (manufacturer = 'Scheibe' AND model LIKE 'SF-%')
   OR (manufacturer = 'Diamond' AND model = 'HK36');

-- Also fix existing aircraft_listings categories
-- Any listing with Lycoming/Continental engine should be Single Engine Piston (1)
UPDATE public.aircraft_listings SET category_id = 1
WHERE is_external = true AND engine_type_name IS NOT NULL
  AND (engine_type_name ILIKE '%lycoming%' OR engine_type_name ILIKE '%continental%');

-- Any listing from Helmut's with Rotax engine should be Light Sport Aircraft (11)
UPDATE public.aircraft_listings SET category_id = 11
WHERE is_external = true AND engine_type_name IS NOT NULL
  AND engine_type_name ILIKE '%rotax%';

-- Fix any that were set to Commercial Airliner (12) — reset to LSA (11) for Helmut's source
UPDATE public.aircraft_listings SET category_id = 11
WHERE is_external = true AND category_id = 12 AND source_name = 'helmuts-ul-seiten.de';

-- Fix trikes/paramotors → Microlight / Flex-Wing (15) in listings
UPDATE public.aircraft_listings SET category_id = 15
WHERE is_external = true
  AND (headline ILIKE '%trike%' OR headline ILIKE '%motorschirm%' OR headline ILIKE '%paramotor%'
       OR headline ILIKE '%gleitschirm%' OR headline ILIKE '%drachen%');

-- Fix gliders/motorgliders → Glider (14) in listings
UPDATE public.aircraft_listings SET category_id = 14
WHERE is_external = true
  AND (headline ILIKE '%motorsegler%' OR headline ILIKE '%segelflug%' OR headline ILIKE '%glider%'
       OR headline ILIKE '%dimona%' OR headline ILIKE '%falke%');
