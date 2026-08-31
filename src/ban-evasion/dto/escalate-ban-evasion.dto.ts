import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for
 * `POST /communities/:slug/join-requests/:id/escalate-ban-evasion`
 * (community owner, co-owner or moderator).
 *
 * `note` is what the moderator wants platform staff to know, and it is
 * OPTIONAL: "please check this one" is a complete request, and requiring a
 * paragraph would make the cheap thing expensive and push moderators towards
 * declining an applicant instead of asking. Plain text, stripped at the write
 * boundary in `CommunityBanEvasionService`.
 */
export class EscalateBanEvasionDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
