import { supabase } from "./client.js";
import { config, type SourceConfig } from "../config.js";
import { logger } from "../utils/logger.js";

const FALLBACK_EMAIL = "noreply@trade.aero";

function findSourceByName(sourceName: string): SourceConfig | null {
  const sources = config.sources as Record<string, SourceConfig>;
  for (const key of Object.keys(sources)) {
    if (sources[key].name === sourceName) return sources[key];
  }
  return null;
}

/**
 * Queue a single claim-invite candidate row for a newly-inserted external
 * listing. Per-source `sendColdEmailInvite` flag gates whether we enqueue;
 * sources without the flag (Aircraft24, Aeromarkt in v1) silently no-op.
 *
 * This is strictly an ENQUEUE — the actual email is sent by the Refactor
 * cron after a legal / kill-switch gate. See
 * TradeAero-Refactor/docs/COLD_EMAIL_CLAIM_CONCEPT.md §8.
 */
export async function enqueueInviteCandidate(params: {
  listingId: string;
  contactEmail: string | null | undefined;
  sourceName: string;
}): Promise<void> {
  const { listingId, contactEmail, sourceName } = params;
  const source = findSourceByName(sourceName);
  if (!source?.sendColdEmailInvite) return;

  const email = (contactEmail ?? "").trim().toLowerCase();
  if (!email || email === FALLBACK_EMAIL) return;

  try {
    const { data: suppressed } = await supabase
      .from("invite_suppressions")
      .select("email")
      .eq("email", email)
      .maybeSingle();
    if (suppressed) {
      logger.debug(
        `[invite-candidate] skipping listing=${listingId} email=${email}: suppressed`,
      );
      return;
    }

    // Unique index on listing_id + onConflict:ignore — safe to call on every
    // insert; repeat calls for the same listing do nothing.
    const { error } = await supabase
      .from("invite_candidates")
      .upsert(
        {
          listing_id: listingId,
          contact_email: email,
          source_name: source.name,
        },
        { onConflict: "listing_id", ignoreDuplicates: true },
      );
    if (error) {
      logger.warn(
        `[invite-candidate] enqueue failed listing=${listingId}: ${error.message}`,
      );
      return;
    }
    logger.debug(
      `[invite-candidate] queued listing=${listingId} source=${source.name}`,
    );
  } catch (err) {
    logger.warn(`[invite-candidate] unexpected error: ${err}`);
  }
}
