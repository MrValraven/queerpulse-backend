/**
 * The fixed set of roles/time-commitments a host picks from when sending a
 * cohost invite (SDD 2026-08-18 "cohost invite flow"). Ids are validated
 * here (`@IsIn`, in the DTOs below); their display labels/descriptions live
 * frontend-side in `cohostInviteOptions.ts`. Kept in sync by id; the two repos
 * do not share code.
 */
export const COHOST_INVITE_ROLE_IDS = [
  'greeter',
  'room_lead',
  'comoderator',
  'page_editor',
] as const;
export type CohostInviteRoleId = (typeof COHOST_INVITE_ROLE_IDS)[number];

export const COHOST_INVITE_COMMITMENT_IDS = [
  'light',
  'half_event',
  'full_event',
  'ongoing',
] as const;
export type CohostInviteCommitmentId =
  (typeof COHOST_INVITE_COMMITMENT_IDS)[number];
