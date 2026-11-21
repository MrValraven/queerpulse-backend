import { BadRequestException } from '@nestjs/common';
import { Community } from './entities/community.entity';
import { RosterRole } from './entities/community-member.entity';

/** Machine reason code for a setup checklist dismissal sent to a space. */
export const SETUP_CHECKLIST_UNAVAILABLE_FOR_SPACES_CODE =
  'setup_checklist_unavailable_for_spaces';

/** Human message paired with `SETUP_CHECKLIST_UNAVAILABLE_FOR_SPACES_CODE`. */
export const SETUP_CHECKLIST_UNAVAILABLE_FOR_SPACES_MESSAGE =
  'Spaces have no setup checklist to dismiss.';

/**
 * The 400 a dismissal on a space answers with. Spaces never show the
 * checklist, so the body names the cause with the machine `code`.
 */
export function setupChecklistUnavailableForSpacesError(): BadRequestException {
  return new BadRequestException({
    message: SETUP_CHECKLIST_UNAVAILABLE_FOR_SPACES_MESSAGE,
    code: SETUP_CHECKLIST_UNAVAILABLE_FOR_SPACES_CODE,
  });
}

/**
 * The only writer of `communities.setup_checklist_dismissed_at`. The
 * `IS NULL` guard makes a repeat or racing send leave the first timestamp in
 * place. The statement leaves `updated_at` as it was.
 * Parameter: `$1` the community id.
 */
export const MARK_SETUP_CHECKLIST_DISMISSED_SQL = `
UPDATE "communities"
SET "setup_checklist_dismissed_at" = now()
WHERE "id" = $1 AND "setup_checklist_dismissed_at" IS NULL
`;

/** The two numbers the checklist reads, counted by the detail builder. */
export interface CommunitySetupChecklistCounts {
  // Roster rows with role owner, co_owner or mod.
  staffCount: number;
  // Posts on the board that are not tombstoned.
  postCount: number;
}

/** The `setupChecklist` block of the community detail response. */
export interface CommunitySetupChecklistDTO {
  isDismissed: boolean;
  staffCount: number;
  postCount: number;
}

const SETUP_CHECKLIST_VIEWER_ROLES: ReadonlySet<RosterRole> = new Set([
  RosterRole.Owner,
  RosterRole.CoOwner,
  RosterRole.Mod,
]);

/**
 * Whether this viewer sees the setup checklist: owner, co-owner or mod of a
 * top-level community. The loose `parentId == null` check reads a fixture
 * with no `parentId` as top level.
 */
export function isSetupChecklistViewer(
  role: RosterRole | null,
  community: Pick<Community, 'parentId'>,
): boolean {
  return (
    role != null &&
    SETUP_CHECKLIST_VIEWER_ROLES.has(role) &&
    community.parentId == null
  );
}

/** Maps the dismissal stamp and the loaded counts to the response block. */
export function toCommunitySetupChecklist(
  community: Pick<Community, 'setupChecklistDismissedAt'>,
  counts: CommunitySetupChecklistCounts,
): CommunitySetupChecklistDTO {
  return {
    isDismissed: community.setupChecklistDismissedAt != null,
    staffCount: counts.staffCount,
    postCount: counts.postCount,
  };
}
