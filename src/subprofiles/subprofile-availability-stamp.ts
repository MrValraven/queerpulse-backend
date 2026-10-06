import type { Subprofile } from './entities/subprofile.entity';

/** The two places a persona states its capacity: the persona-wide
 *  `availability` column and, on a therapist persona, the status switch kept
 *  in `skinData.therapist.status`. The editor and the owner bar save them
 *  together, and either one moving is a status change (PRD-435). */
type CapacityFields = Pick<Subprofile, 'availability' | 'skinData'>;

/**
 * The therapist status stored in `skinData`, or null when there is none.
 * `skin_data` has no server-side schema (the PATCH stores whatever object the
 * editor sends), so a missing block or a non-string value reads as no status.
 */
function therapistStatusOf(skinData: Subprofile['skinData']): string | null {
  const therapist: unknown = skinData?.therapist;
  if (typeof therapist !== 'object' || therapist === null) {
    return null;
  }
  const status = (therapist as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

/** Did the edit move the persona's availability or its therapist status? */
export function hasCapacityChanged(
  committed: CapacityFields,
  edited: CapacityFields,
): boolean {
  return (
    (committed.availability ?? null) !== (edited.availability ?? null) ||
    therapistStatusOf(committed.skinData) !== therapistStatusOf(edited.skinData)
  );
}

/**
 * The `availabilityUpdatedAt` a save writes: `now` when the edit moves the
 * availability or the therapist status away from the committed (locked) row,
 * or when the owner confirmed the status as it stands
 * (`isConfirmation`, the PATCH's `confirmAvailability`). Any other save keeps
 * the committed stamp, so a stale copy loaded before another save can never
 * put an older stamp back.
 */
export function availabilityUpdatedAtAfterSave(
  committed: CapacityFields & Pick<Subprofile, 'availabilityUpdatedAt'>,
  edited: CapacityFields,
  now: Date,
  isConfirmation = false,
): Date | null {
  if (isConfirmation || hasCapacityChanged(committed, edited)) {
    return now;
  }
  return committed.availabilityUpdatedAt ?? null;
}
