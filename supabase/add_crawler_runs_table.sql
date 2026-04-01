-- Crawler run log table for admin dashboard monitoring
-- Stores summary of each crawl execution (aircraft + parts)

CREATE TABLE IF NOT EXISTS public.crawler_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL,                    -- Unique run identifier (timestamp-based)
  source_name text NOT NULL,               -- e.g., "helmuts-ul-seiten.de"
  target text NOT NULL,                    -- "aircraft", "parts", or "all"
  status text NOT NULL DEFAULT 'running',  -- running, completed, failed
  pages_processed integer DEFAULT 0,
  listings_found integer DEFAULT 0,
  listings_inserted integer DEFAULT 0,
  listings_updated integer DEFAULT 0,
  listings_skipped integer DEFAULT 0,
  errors integer DEFAULT 0,
  images_uploaded integer DEFAULT 0,
  translations_completed integer DEFAULT 0,
  duration_ms integer,                     -- Total duration in milliseconds
  error_message text,                      -- Error details if status = 'failed'
  warnings jsonb DEFAULT '[]'::jsonb,      -- Array of warning messages
  metadata jsonb DEFAULT '{}'::jsonb,      -- Additional run metadata (git sha, etc.)
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Index for dashboard queries (most recent runs first)
CREATE INDEX IF NOT EXISTS idx_crawler_runs_started_at
  ON public.crawler_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_crawler_runs_status
  ON public.crawler_runs (status);

-- RLS: Public read for admin dashboard, service role for writes
ALTER TABLE public.crawler_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin users can read crawler runs"
  ON public.crawler_runs FOR SELECT
  USING (true);

CREATE POLICY "Service role can insert crawler runs"
  ON public.crawler_runs FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can update crawler runs"
  ON public.crawler_runs FOR UPDATE
  USING (true);

COMMENT ON TABLE public.crawler_runs IS 'Log of crawler execution runs for admin dashboard monitoring';
