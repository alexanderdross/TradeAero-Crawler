import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/**
 * Supabase client using the SERVICE ROLE key.
 * This bypasses RLS policies, allowing backend ingestion of scraped data.
 * Must only be used server-side in the crawler process.
 */
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false },
  }
);
