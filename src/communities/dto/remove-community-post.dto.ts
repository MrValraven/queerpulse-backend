import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Optional body of `DELETE /communities/:slug/posts/:id` and
 * `DELETE /communities/:slug/posts/:id/replies/:replyId` (PRD-147).
 *
 * WHY A BODY ON A DELETE. The repo already carries a payload on two
 * destructive routes this way (`AdminListingsController.removeByModerator`
 * takes `@Body() dto?: RemoveListingDto`, `MyMediaController.remove` takes a
 * required one), and the frontend's own `apiDelete(path, body)` helper sends
 * one. The alternative precedent, `RemoveMemberQuery`, puts the same three
 * fields in the query string; a moderator's written explanation is prose that
 * ends up in a server access log the moment it travels as a query parameter,
 * so it travels in the body here.
 *
 * EVERY FIELD IS OPTIONAL AND THE WHOLE BODY MAY BE ABSENT. An author deleting
 * their own post sends nothing and is told nothing: see
 * `CommunityPostsService.deletePost`. A moderator may also still act without
 * explaining, because a takedown that is blocked on a form is a takedown that
 * does not happen when it needs to. What changes is that the reason now has
 * somewhere to go.
 */
export class RemoveCommunityPostDto {
  /**
   * The moderator's explanation, WRITTEN FOR THE MEMBER TO READ. It is stored
   * on the community's governance log and sent to the author with their
   * notification, which is the only channel that reaches them: QueerPulse
   * sends no email and there is no way to message a community's moderators.
   *
   * Same 500-character ceiling and same posture as `CommunityBan.reason`,
   * which this is modelled on. Anything the moderators want to keep between
   * themselves goes in `internalNote` instead.
   *
   * Stripped to plain text at the write boundary (`toStoredPlainTextOrNull`)
   * before it is stored or forwarded, so a takedown note can never carry
   * markup into a surface that renders it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * Which of the community's own house rules the takedown rests on, 0-based
   * into `Community.rules`. The same citation vocabulary a ban already uses
   * (`RemoveMemberQuery.ruleIndex`, `resolveRuleSnapshot`,
   * `CommunityBanRuleCitationDTO`), reused rather than reinvented, so a
   * moderator cites a rule the same way whatever they are acting on.
   *
   * The index alone is not what gets stored. `Community.rules` is a plain
   * array and `Community.rulesVersion` moves whenever an owner edits it, so
   * the server snapshots the version and the rule's exact wording alongside
   * it. An index outside the current rules is dropped rather than stored, so a
   * citation never points at a rule that does not exist.
   *
   * Optional, for the same reason a ban's citation is: content can breach no
   * written rule and still have to go, and a community with no rules has
   * nothing to cite.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(199)
  ruleIndex?: number;

  /**
   * MODERATOR-ONLY working note, NEVER sent to the author and never placed in
   * any member-facing payload. This is where "third time this week" and "same
   * account as the one we barred in March" go, so `reason` can stay the thing
   * the member actually reads. The separation `CommunityJoinRequest`'s
   * `internalNote` / `declineReason` pair already draws.
   *
   * It reaches the community's own governance log, which is owner/co-owner/mod
   * only, and stops there. `CommunityPostsService.recordTakedown` is the one
   * place that must keep it out of the notification payload.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNote?: string;
}
