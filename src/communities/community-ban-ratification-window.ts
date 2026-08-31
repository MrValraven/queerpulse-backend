/**
 * How long a PERMANENT community bar waits for its second signature, what the
 * bar serves in the meantime, and the `mod_audit_logs` code the hold's opening
 * writes.
 *
 * A separate file from `community-ban-ratification.service.ts` for the same
 * reason `ban-ratification-window.ts` is separate from
 * `ban-ratification.service.ts` at platform level: `CommunitiesService`
 * (through `barReturn`) is the only thing that writes a `community_bans` row,
 * so it owns the fallback term, while `CommunityBanRatificationService` decides
 * and expires the hold. Keeping the constants here means neither file has to
 * import the other for a number.
 *
 * PRD-25. A platform permanent ban has needed a second moderator since TS-12
 * (`BanRatification`). The community-level equivalent, which is the removal
 * most members actually meet, had no such check: one owner or moderator barred
 * someone forever in a single `DELETE /communities/:slug/members/:memberSlug`.
 */

/**
 * 72 hours, the same window the platform hold uses, and for the same reason: a
 * bar proposed on a Friday evening is still waiting when the next moderator
 * looks on Monday, which is the case that decides whether this control gets
 * used or gets routed around.
 *
 * It is safer here than at platform level, because nothing about the member's
 * standing is left undecided while the clock runs. They are off the roster from
 * the first second and the bar is already in force at
 * {@link COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS} days. Only the PERMANENCE
 * waits.
 */
export const COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS = 72;

const COMMUNITY_BAN_RATIFICATION_WINDOW_MS =
  COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * What an unratified permanent bar serves instead: 30 days, not nothing.
 *
 * The platform hold lapses to nothing, because there the interim consequence is
 * a suspension imposed before anyone confirmed the decision behind it. Here the
 * first signature is a community's own owner or moderator acting inside their
 * own room, on conduct they witnessed, and a removal they were entitled to
 * make. Lapsing that to nothing would put the person straight back through the
 * door on a technicality of staffing. Thirty days is the bar the one signature
 * on file is worth: long enough to be a real sanction, short enough that no
 * single person hands out a life sentence.
 */
export const COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS = 30;

/** The instant a hold opened at `now` lapses. */
export function communityBanHoldExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + COMMUNITY_BAN_RATIFICATION_WINDOW_MS);
}
