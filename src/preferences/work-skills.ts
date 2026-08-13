// The skills-exchange vocabulary. These ids are the contract with the
// frontend's `WORK_SKILLS` list (`features/economy/workProfile.data.ts`) — the
// ids are taken from there verbatim, not invented here. Single source of truth
// on this side; do not inline the list anywhere else. Same idiom as
// `trans-support.ts`.
export const WORK_SKILL_IDS = [
  'branding',
  'backend',
  'fundraising',
  'photography',
  'copywriting',
  'product',
] as const;

export type WorkSkillId = (typeof WORK_SKILL_IDS)[number];

/**
 * De-duplicates a submitted skills selection, first occurrence wins so the
 * member's chosen order survives a round-trip.
 *
 * Deliberately does NO validation — an unknown id is a 400 raised by
 * `UpdateWorkPreferencesDto`, never something this function has to cope with.
 * Same reasoning as `normalizeTransSupport`.
 */
export function normalizeWorkSkills(ids: string[]): string[] {
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
