import { UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { STUDIO_FORMAT_BY_KIND } from '../studio/studio.constants';
import type { StudioFormat } from '../studio/studio.constants';
import { StudioReleaseStatus } from '../studio/entities/studio-release.entity';
import { SubprofileKind } from './entities/subprofile.entity';
import type { SkinData, TherapistStatus } from './entities/subprofile.entity';
import { FAMILY_OF_KIND } from './subprofile-kinds';
import type { SkinFamily } from './subprofile-kinds';
import { AVAILABILITY_TO_TATTOO_STATUS } from './tattoo-artist-vocab';

/** Why `POST /subprofiles/:id/kind` refuses a kind change. Each code carries
 *  the details the FE needs to name the reason. */
export type PersonaKindChangeRejection =
  | { code: 'PERSONA_KIND_UNCHANGED' }
  | {
      code: 'PERSONA_KIND_OTHER_FAMILY';
      currentFamily: SkinFamily;
      requestedFamily: SkinFamily;
    }
  | { code: 'PERSONA_KIND_STUDIO_TAKEN_DOWN'; takenDownCount: number }
  | {
      code: 'PERSONA_KIND_STUDIO_RELEASES';
      releaseCount: number;
      requestedHasStudio: boolean;
    };

/** A persona's Studio releases split by status. `activeCount` is every
 *  draft, scheduled and published release. */
export interface StudioReleaseCounts {
  takenDownCount: number;
  activeCount: number;
}

/** The family rule. A kind change stays inside the persona's family, except
 *  that a `generic` persona may switch into any family. The same kind is
 *  refused first. */
export function personaKindRuleRejection(
  currentKind: SubprofileKind,
  requestedKind: SubprofileKind,
): PersonaKindChangeRejection | null {
  if (currentKind === requestedKind) {
    return { code: 'PERSONA_KIND_UNCHANGED' };
  }
  const currentFamily = FAMILY_OF_KIND[currentKind];
  const requestedFamily = FAMILY_OF_KIND[requestedKind];
  if (
    currentKind !== SubprofileKind.Generic &&
    currentFamily !== requestedFamily
  ) {
    return {
      code: 'PERSONA_KIND_OTHER_FAMILY',
      currentFamily,
      requestedFamily,
    };
  }
  return null;
}

// The format map read by any kind, so a kind outside the artist kinds gives
// `undefined` instead of a type error.
const STUDIO_FORMAT_OF_KIND: Partial<Record<string, StudioFormat>> =
  STUDIO_FORMAT_BY_KIND;

/** The Studio format a kind publishes, or null for a kind outside Studio. */
export function studioFormatOf(kind: SubprofileKind): StudioFormat | null {
  return STUDIO_FORMAT_OF_KIND[kind] ?? null;
}

/** True when the two kinds publish different Studio formats, counting "no
 *  Studio" as a format of its own. */
export function hasStudioFormatChange(
  currentKind: SubprofileKind,
  requestedKind: SubprofileKind,
): boolean {
  return studioFormatOf(currentKind) !== studioFormatOf(requestedKind);
}

/** The Studio guard, called only when the Studio format changes. A release
 *  our team took down is named before any other status, since only our team
 *  can clear it. */
export function studioReleaseRejection(
  requestedKind: SubprofileKind,
  counts: StudioReleaseCounts,
): PersonaKindChangeRejection | null {
  if (counts.takenDownCount > 0) {
    return {
      code: 'PERSONA_KIND_STUDIO_TAKEN_DOWN',
      takenDownCount: counts.takenDownCount,
    };
  }
  if (counts.activeCount > 0) {
    return {
      code: 'PERSONA_KIND_STUDIO_RELEASES',
      releaseCount: counts.activeCount,
      requestedHasStudio: studioFormatOf(requestedKind) !== null,
    };
  }
  return null;
}

function personaKindChangeMessage(
  rejection: PersonaKindChangeRejection,
): string {
  switch (rejection.code) {
    case 'PERSONA_KIND_UNCHANGED':
      return 'This persona already has that type.';
    case 'PERSONA_KIND_OTHER_FAMILY':
      return `A ${rejection.currentFamily} persona can only switch to another ${rejection.currentFamily} type.`;
    case 'PERSONA_KIND_STUDIO_TAKEN_DOWN':
      return 'Our team took down a Studio release on this persona. Ask our team before changing its type.';
    case 'PERSONA_KIND_STUDIO_RELEASES': {
      const { releaseCount, requestedHasStudio } = rejection;
      return `This persona has ${releaseCount} Studio ${releaseCount === 1 ? 'release' : 'releases'}, and the new type ${requestedHasStudio ? 'publishes a different Studio format' : "can't publish in Studio"}. Unschedule, unpublish or delete them first.`;
    }
  }
}

/** The 422 for a refused kind change: `{ code, message, ...details }`. */
export function personaKindChangeException(
  rejection: PersonaKindChangeRejection,
): UnprocessableEntityException {
  const { code, ...details } = rejection;
  return new UnprocessableEntityException({
    code,
    message: personaKindChangeMessage(rejection),
    ...details,
  });
}

/** One row per release status a persona holds. Served by
 *  `IDX_studio_releases_subprofile_status`. */
export const STUDIO_RELEASE_COUNTS_SQL =
  'SELECT "status", COUNT(*)::int AS "count" FROM "studio_releases" WHERE "subprofile_id" = $1 GROUP BY "status"';

interface StudioReleaseStatusCountRow {
  status: string;
  count: number | string;
}

/** Counts a persona's Studio releases, taken down apart from every other
 *  status. */
export async function countStudioReleasesByStatus(
  manager: Pick<EntityManager, 'query'>,
  subprofileId: string,
): Promise<StudioReleaseCounts> {
  const rows = await manager.query<StudioReleaseStatusCountRow[]>(
    STUDIO_RELEASE_COUNTS_SQL,
    [subprofileId],
  );
  let takenDownCount = 0;
  let activeCount = 0;
  for (const row of rows) {
    const rowCount = Number(row.count);
    if (row.status === (StudioReleaseStatus.TakenDown as string)) {
      takenDownCount += rowCount;
    } else {
      activeCount += rowCount;
    }
  }
  return { takenDownCount, activeCount };
}

type AvailabilityKey = 'open_to_collabs' | 'booking' | 'not_available';

/** The therapist status each availability pairs with. Mirrors the FE
 *  `CAPACITY_OPTIONS` (`queerpulse/src/features/subprofiles/skins/therapist/
 *  therapistHero.data.ts:21-45`), the pairing the FE therapist sync applies in
 *  `useEditorSaveGraph.ts:116-139`, which exists only on the frontend. */
export const AVAILABILITY_TO_THERAPIST_STATUS: Readonly<
  Record<AvailabilityKey, TherapistStatus>
> = {
  open_to_collabs: 'open',
  booking: 'wait',
  not_available: 'closed',
};

function isAvailabilityKey(
  availability: string | null,
): availability is AvailabilityKey {
  return (
    availability !== null &&
    Object.prototype.hasOwnProperty.call(
      AVAILABILITY_TO_THERAPIST_STATUS,
      availability,
    )
  );
}

/** True when a stored block is a plain object. A missing, null or malformed
 *  block has nothing to rewrite. */
function isPlainObject<Block extends object>(
  value: Block | null | undefined,
): value is Block {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tattooSkinDataAfterSwitch(
  skinData: SkinData,
  availability: string | null,
): SkinData {
  const tattoo = skinData.tattoo;
  if (!isPlainObject(tattoo)) {
    return skinData;
  }
  if (isAvailabilityKey(availability)) {
    const status = AVAILABILITY_TO_TATTOO_STATUS[availability];
    if (tattoo.status === status) {
      return skinData;
    }
    return { ...skinData, tattoo: { ...tattoo, status } };
  }
  // No availability: removing the status is the closest match to "no
  // availability", and it keeps `availabilityAfterTattooSync`
  // (`subprofiles.service.ts:3018-3022`) from replacing null on the next save.
  if (!('status' in tattoo)) {
    return skinData;
  }
  const tattooWithoutStatus = { ...tattoo };
  delete tattooWithoutStatus.status;
  return { ...skinData, tattoo: tattooWithoutStatus };
}

function therapistSkinDataAfterSwitch(
  skinData: SkinData,
  availability: string | null,
): SkinData {
  const therapist = skinData.therapist;
  // The server never derives availability from the therapist status, so a
  // null availability leaves the block alone and nothing overwrites it later.
  if (!isPlainObject(therapist) || !isAvailabilityKey(availability)) {
    return skinData;
  }
  const status = AVAILABILITY_TO_THERAPIST_STATUS[availability];
  if (therapist.status === status) {
    return skinData;
  }
  return { ...skinData, therapist: { ...therapist, status } };
}

/** The skin data a kind change writes, so the requested kind's status block
 *  agrees with the persona's availability. Never mutates its input and gives
 *  back the same reference when nothing changes. A missing or null block is
 *  left alone, since nothing is stored to rewrite. */
export function skinDataAfterKindSwitch(
  requestedKind: SubprofileKind,
  skinData: SkinData | null,
  availability: string | null,
): SkinData | null {
  if (skinData === null) {
    return skinData;
  }
  if (requestedKind === SubprofileKind.TattooArtist) {
    return tattooSkinDataAfterSwitch(skinData, availability);
  }
  if (requestedKind === SubprofileKind.Therapist) {
    return therapistSkinDataAfterSwitch(skinData, availability);
  }
  return skinData;
}
