// The shared "Open to" vocabulary. The SAME nine ids drive the profile chips,
// the member-directory filter and the connect form's reason select, so this
// module is the single source of truth — do not inline the list anywhere else.
export const OPEN_TO_PRESET_IDS = [
  'collaborating',
  'mentoring',
  'casualMeetups',
  'commissions',
  'clientWork',
  'referrals',
  'swaps',
  'studioVisits',
  'interviewees',
] as const;

export type OpenToPresetId = (typeof OPEN_TO_PRESET_IDS)[number];

// A member's availability chip: either one of the shared presets, or their own
// words. Customs are deliberately the long tail the taxonomy does not cover
// ("A nurse or two for the testing nights") — they are the house voice and are
// stored verbatim.
export type OpenToEntry =
  | { kind: 'preset'; id: OpenToPresetId }
  | { kind: 'custom'; label: string };

// The loose shape that arrives from the DTO. `kind` is narrowed and `id` is
// range-checked by class-validator before this reaches normalizeOpenTo, so the
// narrowing below is safe.
export interface OpenToEntryInput {
  kind: string;
  id?: string;
  label?: string;
}

export const MAX_OPEN_TO_ENTRIES = 12;
export const MAX_OPEN_TO_LABEL_LENGTH = 60;
export const MAX_NOW_LENGTH = 280;

/**
 * Cleans a submitted `openTo` list: trims custom labels, drops entries left
 * empty by that trim, and de-duplicates (presets by id, customs
 * case-insensitively). First occurrence wins, so the member's chosen chip
 * order survives.
 *
 * Deliberately does NO validation — an unknown preset id is a 400 raised by
 * `UpdateProfileDto`, never something this function has to cope with. Storing
 * an unknown id would be invisible-but-filterable data, since the client drops
 * ids it does not recognise on read.
 */
export function normalizeOpenTo(entries: OpenToEntryInput[]): OpenToEntry[] {
  const out: OpenToEntry[] = [];
  const seenPresets = new Set<string>();
  const seenCustoms = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === 'preset') {
      const id = entry.id;
      if (!id || seenPresets.has(id)) {
        continue;
      }
      seenPresets.add(id);
      out.push({ kind: 'preset', id: id as OpenToPresetId });
      continue;
    }

    const label = (entry.label ?? '').trim();
    if (!label) {
      continue;
    }
    const key = label.toLowerCase();
    if (seenCustoms.has(key)) {
      continue;
    }
    seenCustoms.add(key);
    out.push({ kind: 'custom', label });
  }

  return out;
}
