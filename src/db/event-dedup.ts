import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Pure dedup-decision helpers for the events upsert path. Lives in
// its own module so unit tests can import without triggering the
// Supabase client init in `db/events.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable hash of the translatable content — drives re-translate
 * decisions in `upsertEvent`. A row is re-translated only when this
 * hash differs between the existing DB row and the new ParsedEvent;
 * unchanged content skips the Anthropic call (and the cost it
 * carries).
 */
export function contentHash(title: string, description: string): string {
  return createHash("sha1").update(`${title} ${description}`).digest("hex");
}

/**
 * Base slug for the `slug` column — the schema requires UNIQUE NOT NULL
 * so we append an 8-char sha1 fragment of the title to guarantee
 * uniqueness without an extra DB round-trip. Fragment must stay
 * deterministic per title or re-runs of the crawler emit fresh rows
 * every time instead of upserting.
 */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const suffix = createHash("sha1").update(title).digest("hex").slice(0, 8);
  return `${base || "event"}-${suffix}`;
}
