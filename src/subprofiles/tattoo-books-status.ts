import { SubprofileKind } from './entities/subprofile.entity';
import type { SkinData } from './entities/subprofile.entity';
import {
  TATTOO_BOOKS_STATUSES,
  TATTOO_STATUS_TO_AVAILABILITY,
} from './tattoo-artist-vocab';
import type { TattooBooksStatus } from './tattoo-artist-vocab';

/**
 * The tattoo books status stored in `skinData.tattoo.status`, or null when the
 * block is missing, malformed, or holds a value outside the listed statuses.
 */
export function tattooBooksStatusOf(
  skinData: SkinData | null | undefined,
): TattooBooksStatus | null {
  const tattoo: unknown = skinData?.tattoo;
  if (typeof tattoo !== 'object' || tattoo === null) {
    return null;
  }
  const status: unknown = (tattoo as { status?: unknown }).status;
  return (TATTOO_BOOKS_STATUSES as readonly unknown[]).includes(status)
    ? (status as TattooBooksStatus)
    : null;
}

/**
 * The availability a save writes for a tattoo artist persona: the one the
 * books status maps to, whatever the PATCH sent. Without a listed status, or
 * for any other kind, the sent availability stays.
 */
export function availabilityAfterTattooSync(
  kind: SubprofileKind,
  skinData: SkinData | null | undefined,
  availability: string | null,
): string | null {
  if (kind !== SubprofileKind.TattooArtist) {
    return availability;
  }
  const status = tattooBooksStatusOf(skinData);
  return status === null ? availability : TATTOO_STATUS_TO_AVAILABILITY[status];
}
