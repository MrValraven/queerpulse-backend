import { UserStatus } from '../users/entities/user.entity';
import { ProfileVisibility } from '../users/entities/profile.entity';
import {
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import { ListingStatus } from './entities/listing.entity';
import { ADULT_LISTING_CATEGORY_SLUG } from './listing-categories';

/**
 * SQL boolean fragments for the "Meet the team" reads. Each one restates a
 * rule that already lives in code, so a team read shows exactly what the
 * matching single-record read shows:
 *
 * - `SubprofilePublicReadService.assertPublicViewVisible`
 *   (`src/subprofiles/subprofile-public-read.service.ts`): a persona is
 *   visible when it is published, kept (no `removed_at`), free of a moderator
 *   takedown, open or network, and unblocked in both directions. A `network`
 *   persona or a linked persona waits for an active member.
 * - `PublicProfilesService` (`src/public-profiles/public-profiles.service.ts`):
 *   a member profile is visible when it is open, not self-hidden, not under a
 *   moderator takedown (`isTakenDown`), and, for an anonymous visitor, when
 *   the member turned `public_profile_enabled` on.
 * - `DirectoryService.loadLiveOr404` (`src/listings/directory.service.ts`): a
 *   listing is public when it is live, shown by its owner and not under a
 *   takedown keyed by its slug.
 *
 * Every function takes the outer alias and returns an expression over quoted
 * names. Inner subquery aliases carry the outer alias as a prefix, so two
 * fragments never collide in one query. `notBlockedEitherWaySql` takes no
 * outer alias and uses the fixed inner alias "team_block", which stays safe in
 * sibling or nested NOT EXISTS scopes because the member column is always
 * qualified. Aliases and columns are code
 * constants; viewers always arrive as positional parameters.
 */

/**
 * The moderation subject types a listing takedown can be filed under.
 * Mirrors the private `DirectoryService.SUBJECT_TYPES`.
 */
export const LISTING_MODERATION_SUBJECT_TYPES = [
  'business',
  'listing',
] as const;

/**
 * A persona that may appear on a team at all: published, kept, with a
 * handle, open or network visibility, no takedown, and an active owner.
 */
export function eligiblePersonaSql(personaAlias: string): string {
  const moderationAlias = `${personaAlias}_moderation`;
  const ownerAlias = `${personaAlias}_owner`;
  return [
    `"${personaAlias}"."status" = '${SubprofileStatus.Published}'`,
    `"${personaAlias}"."removed_at" IS NULL`,
    `"${personaAlias}"."handle" IS NOT NULL`,
    `"${personaAlias}"."visibility" IN ('${SubprofileVisibility.Open}', '${SubprofileVisibility.Network}')`,
    `NOT EXISTS (SELECT 1 FROM "content_moderation" "${moderationAlias}" WHERE "${moderationAlias}"."subject_type" = '${SUBPROFILE_MODERATION_SUBJECT_TYPE}' AND "${moderationAlias}"."subject_id" = "${personaAlias}"."id"::text AND ("${moderationAlias}"."hidden_at" IS NOT NULL OR "${moderationAlias}"."removed_at" IS NOT NULL))`,
    `EXISTS (SELECT 1 FROM "users" "${ownerAlias}" WHERE "${ownerAlias}"."id" = "${personaAlias}"."user_id" AND "${ownerAlias}"."status" = '${UserStatus.Active}')`,
  ].join(' AND ');
}

/** The `content_moderation.subject_type` a member takedown is filed under.
 *  Mirrors the private `PublicProfilesService.MEMBER_SUBJECT_TYPE`. */
export const MEMBER_MODERATION_SUBJECT_TYPE = 'member';

/**
 * A member that may appear on a team at all: an active account, an open
 * profile, not self-hidden (`hidden_until` unset or already past) and free of
 * a moderator takedown filed under their slug or user id (the rule of
 * `PublicProfilesService.isTakenDown`). The caller joins both the profile and
 * the user row under the given aliases.
 */
export function eligibleMemberSql(
  profileAlias: string,
  userAlias: string,
): string {
  const moderationAlias = `${profileAlias}_moderation`;
  return [
    `"${userAlias}"."status" = '${UserStatus.Active}'`,
    `"${profileAlias}"."visibility" = '${ProfileVisibility.Open}'`,
    `("${profileAlias}"."hidden_until" IS NULL OR "${profileAlias}"."hidden_until" <= now())`,
    `NOT EXISTS (SELECT 1 FROM "content_moderation" "${moderationAlias}" WHERE "${moderationAlias}"."subject_type" = '${MEMBER_MODERATION_SUBJECT_TYPE}' AND "${moderationAlias}"."subject_id" IN ("${profileAlias}"."slug", "${profileAlias}"."user_id"::text) AND ("${moderationAlias}"."hidden_at" IS NOT NULL OR "${moderationAlias}"."removed_at" IS NOT NULL))`,
  ].join(' AND ');
}

/**
 * What an anonymous viewer may see of a member: an eligible one whose
 * `member_preferences.public_profile_enabled` is on. A member without a
 * preferences row has not opted in, so the EXISTS reads false for them.
 */
export function anonymousVisibleMemberSql(
  profileAlias: string,
  userAlias: string,
): string {
  const preferencesAlias = `${profileAlias}_preferences`;
  return [
    eligibleMemberSql(profileAlias, userAlias),
    `EXISTS (SELECT 1 FROM "member_preferences" "${preferencesAlias}" WHERE "${preferencesAlias}"."user_id" = "${profileAlias}"."user_id" AND "${preferencesAlias}"."public_profile_enabled" = true)`,
  ].join(' AND ');
}

/**
 * True when the member did not hide their profile from the viewer
 * (`hidden_from_members.owner_id = member AND hidden_from_user_id = viewer`).
 * `viewerParameter` is a positional parameter such as `$2` and `memberColumn`
 * a quoted column reference such as `"member_profile"."user_id"`. Uses the
 * fixed inner alias "team_hidden", safe for the same reason as "team_block".
 */
export function notHiddenFromViewerSql(
  viewerParameter: string,
  memberColumn: string,
): string {
  return `NOT EXISTS (SELECT 1 FROM "hidden_from_members" "team_hidden" WHERE "team_hidden"."owner_id" = ${memberColumn} AND "team_hidden"."hidden_from_user_id" = ${viewerParameter})`;
}

/**
 * What an anonymous viewer may see of an eligible persona: open and unlinked
 * only, since linked and network personas wait for an active member.
 */
export function anonymousVisiblePersonaSql(personaAlias: string): string {
  return `"${personaAlias}"."visibility" = '${SubprofileVisibility.Open}' AND "${personaAlias}"."link_visibility" <> '${SubprofileLinkVisibility.Linked}'`;
}

/**
 * True when no block exists between the viewer and the member, in either
 * direction. `viewerParameter` is a positional parameter such as `$2` and
 * `memberColumn` a quoted column reference such as `"persona"."user_id"`.
 */
export function notBlockedEitherWaySql(
  viewerParameter: string,
  memberColumn: string,
): string {
  return `NOT EXISTS (SELECT 1 FROM "blocks" "team_block" WHERE ("team_block"."blocker_id" = ${viewerParameter} AND "team_block"."blocked_id" = ${memberColumn}) OR ("team_block"."blocker_id" = ${memberColumn} AND "team_block"."blocked_id" = ${viewerParameter}))`;
}

/** A live listing its owner shows and no moderator has taken down. */
export function publiclyVisibleListingSql(listingAlias: string): string {
  const moderationAlias = `${listingAlias}_moderation`;
  const subjectTypes = LISTING_MODERATION_SUBJECT_TYPES.map(
    (subjectType) => `'${subjectType}'`,
  ).join(', ');
  return [
    `"${listingAlias}"."status" = '${ListingStatus.Live}'`,
    `"${listingAlias}"."is_hidden_by_owner" = false`,
    `NOT EXISTS (SELECT 1 FROM "content_moderation" "${moderationAlias}" WHERE "${moderationAlias}"."subject_type" IN (${subjectTypes}) AND "${moderationAlias}"."subject_id" = "${listingAlias}"."slug" AND ("${moderationAlias}"."hidden_at" IS NOT NULL OR "${moderationAlias}"."removed_at" IS NOT NULL))`,
  ].join(' AND ');
}

/** Leaves out the 18+ category, which public reads never list. */
export function notAdultListingSql(listingAlias: string): string {
  return `NOT ('${ADULT_LISTING_CATEGORY_SLUG}' = ANY("${listingAlias}"."cats"))`;
}
