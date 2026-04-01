-- Add cost tracking columns to crawler_runs for admin dashboard
-- Tracks Bright Data proxy bandwidth and Anthropic translation token usage

ALTER TABLE public.crawler_runs
  ADD COLUMN IF NOT EXISTS proxy_bytes_transferred bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS translation_input_tokens integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS translation_output_tokens integer DEFAULT 0;

COMMENT ON COLUMN public.crawler_runs.proxy_bytes_transferred IS 'Total bytes transferred through Bright Data proxy during this run';
COMMENT ON COLUMN public.crawler_runs.translation_input_tokens IS 'Total Anthropic API input tokens used for translation';
COMMENT ON COLUMN public.crawler_runs.translation_output_tokens IS 'Total Anthropic API output tokens used for translation';
