-- Reference performance specs for known aircraft models.
-- Pre-filled by Claude Haiku AI, enriched over time.
-- Used by the crawler to fill missing performance data on listings.

CREATE TABLE IF NOT EXISTS public.aircraft_reference_specs (
  id serial PRIMARY KEY,
  manufacturer text NOT NULL,
  model text NOT NULL,
  variant text,                          -- e.g., "ULS", "iS", "S"

  -- Performance
  cruise_speed text,                     -- e.g., "220"
  cruise_speed_unit text DEFAULT 'km/h',
  max_speed text,
  max_speed_unit text DEFAULT 'km/h',
  max_range text,                        -- e.g., "1200"
  max_range_unit text DEFAULT 'km',
  service_ceiling text,
  service_ceiling_unit text DEFAULT 'ft',
  climb_rate text,                       -- e.g., "5.5"
  climb_rate_unit text DEFAULT 'm/s',
  takeoff_distance text,                 -- e.g., "200"
  takeoff_distance_unit text DEFAULT 'm',
  landing_distance text,
  landing_distance_unit text DEFAULT 'm',
  fuel_consumption text,                 -- e.g., "18"
  fuel_consumption_unit text DEFAULT 'l/h',

  -- Weights
  empty_weight text,
  empty_weight_unit text DEFAULT 'kg',
  max_takeoff_weight text,
  max_takeoff_weight_unit text DEFAULT 'kg',
  max_payload text,
  max_payload_unit text DEFAULT 'kg',
  fuel_capacity text,
  fuel_capacity_unit text DEFAULT 'l',

  -- Engine defaults
  engine_type text,                      -- e.g., "Rotax 912 ULS"
  engine_power text,                     -- e.g., "100"
  engine_power_unit text DEFAULT 'PS',
  fuel_type text,                        -- e.g., "MOGAS"

  -- General
  seats text DEFAULT '2',
  category text DEFAULT 'Light Sport Aircraft',

  -- Metadata
  source text DEFAULT 'claude-haiku',    -- 'claude-haiku', 'manual', 'wikipedia'
  confidence text DEFAULT 'high',        -- 'high', 'medium', 'low'
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),

  UNIQUE(manufacturer, model, variant)
);

-- Index for fast lookup by manufacturer + model
CREATE INDEX IF NOT EXISTS idx_aircraft_ref_specs_lookup
  ON public.aircraft_reference_specs (lower(manufacturer), lower(model));

-- RLS
ALTER TABLE public.aircraft_reference_specs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access to reference specs"
  ON public.aircraft_reference_specs FOR SELECT USING (true);

CREATE POLICY "Service role can manage reference specs"
  ON public.aircraft_reference_specs FOR ALL USING (true);

COMMENT ON TABLE public.aircraft_reference_specs IS 'Reference performance specs for known aircraft models, used to enrich crawled listings';
