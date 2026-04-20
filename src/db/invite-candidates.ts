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
 * sources without the flag (Aircraft24, Aeromarkt pending TOS audit)
 * silently no-op.
 *
 * Covers both aircraft + parts listings (§3a of
 * TradeAero-Refactor/docs/COLD_EMAIL_CLAIM_CONCEPT.md; requires Refactor
 * migration 20260422_cold_email_expand_to_parts.sql).
 *
 * This is strictly an ENQUEUE — the actual email is sent by the Refactor
 * cron after a legal / kill-switch gate. See §8.
 */
export async function enqueueInviteCandidate(params: {
  listingId: string;
  listingType: "aircraft" | "parts";
  contactEmail: string | null | undefined;
  sourceName: string;
}): Promise<void> {
  const { listingId, listingType, contactEmail, sourceName } = params;
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
        `[invite-candidate] skipping listing=${listingId} type=${listingType} email=${email}: suppressed`,
      );
      return;
    }

    // Unique index on (listing_id, listing_type) + onConflict:ignore —
    // safe to call on every insert; repeat calls for the same listing
    // do nothing.
    const { error } = await supabase
      .from("invite_candidates")
      .upsert(
        {
          listing_id: listingId,
          listing_type: listingType,
          contact_email: email,
          source_name: source.name,
        },
        { onConflict: "listing_id,listing_type", ignoreDuplicates: true },
      );
    if (error) {
      logger.warn(
        `[invite-candidate] enqueue failed listing=${listingId} type=${listingType}: ${error.message}`,
      );
      return;
    }
    logger.debug(
      `[invite-candidate] queued listing=${listingId} type=${listingType} source=${source.name}`,
    );
  } catch (err) {
    logger.warn(`[invite-candidate] unexpected error: ${err}`);
  }
}
