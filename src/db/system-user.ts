import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";

/**
 * System user for scraped listings (Epic 3.3).
 *
 * External listings need a user_id for FK constraints but must NOT be
 * editable by real users. We use a dedicated system profile.
 *
 * The system user is created once in Supabase Auth and its UUID is stored
 * as an environment variable. If not set, we look it up by email.
 */
const SYSTEM_EMAIL = "crawler@trade.aero";

let cachedSystemUserId: string | null = null;

export async function getSystemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;

  // Check env override first
  if (process.env.CRAWLER_SYSTEM_USER_ID) {
    cachedSystemUserId = process.env.CRAWLER_SYSTEM_USER_ID;
    return cachedSystemUserId;
  }

  // Look up by email in profiles table
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", SYSTEM_EMAIL)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up system user: ${error.message}`);
  }

  if (data) {
    cachedSystemUserId = data.id;
    logger.info("Found system user", { id: data.id });
    return data.id;
  }

  throw new Error(
    `System user not found. Please create a profile with email "${SYSTEM_EMAIL}" ` +
    `or set CRAWLER_SYSTEM_USER_ID in .env`
  );
}
