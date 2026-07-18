// The trans-support option vocabulary. These ids are the contract with the
// frontend's `TRANS_SUPPORT` list (`features/economy/workProfile.data.ts`) —
// the ids are taken from there verbatim, not invented here. Single source of
// truth on this side; do not inline the list anywhere else.
export const TRANS_SUPPORT_IDS = [
  'chosen-name',
  'hide-legal',
  'transition-friendly',
] as const;

export type TransSupportId = (typeof TRANS_SUPPORT_IDS)[number];

/**
 * De-duplicates a submitted trans-support selection, first occurrence wins so
 * the member's chosen order survives a round-trip.
 *
 * Deliberately does NO validation — an unknown id is a 400 raised by
 * `UpdateWorkPreferencesDto`, never something this function has to cope with.
 * Same reasoning as `normalizeOpenTo` in `src/profiles/open-to.ts`: storing an
 * unknown id would be invisible-but-filterable data, since the client only
 * renders ids it recognises.
 */
export function normalizeTransSupport(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }

  return out;
}
