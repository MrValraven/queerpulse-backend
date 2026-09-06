import { ContentModerationService } from '../content-moderation/content-moderation.service';

/**
 * The `content_moderation.subject_type` a persona takedown is recorded under.
 * A persona is keyed by its `slug` (never its uuid) in that table, so every
 * read of this state passes `subprofile.slug`.
 *
 * This is the ONE spelling of the persona takedown subject type. Anything that
 * needs to know "is this persona under a moderator takedown?" should read it
 * from here rather than re-deriving the string or the hidden/removed rule.
 */
export const SUBPROFILE_MODERATION_SUBJECT_TYPE = 'subprofile';

/**
 * Canonical "is this persona under a moderator takedown?" check for the single
 * persona case.
 *
 * A takedown is EITHER `hide_content` (hidden) or `remove_content` (removed):
 * both withhold the persona from every public surface, so both count here. This
 * is the same rule the batched read paths apply
 * (`SubprofilePublicReadService.dropModeratedSubprofiles` post-fetch, and
 * `excludeModeratedSubprofiles` in-query), lifted out so the WRITE paths
 * (follow, endorse, and the endorser list they gate) can share one spelling
 * rather than growing a second.
 *
 * Takes the caller's own injected {@link ContentModerationService} instead of
 * being a method on it, so this stays a subprofiles-domain rule and the
 * dependency arrow keeps pointing one way (subprofiles -> content-moderation).
 */
export async function isSubprofileUnderTakedown(
  contentModeration: ContentModerationService,
  slug: string,
): Promise<boolean> {
  const state = await contentModeration.stateFor(
    SUBPROFILE_MODERATION_SUBJECT_TYPE,
    slug,
  );
  return state.hidden || state.removed;
}
