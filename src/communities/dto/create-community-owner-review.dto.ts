import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /communities/:slug/owner-review` (any roster member except
 * the community's owner).
 *
 * `reason` is REQUIRED, unlike the nullable column behind it (which is
 * nullable so a future staff-side or automated route can write a row without
 * one). Platform staff read these to decide whether to reassign a community,
 * and "the owner is gone" with no account of what that looked like is not
 * something anyone can act on. The minimum length is a floor against an empty
 * gesture, not a word count.
 *
 * Stored as plain text: `CommunityOwnerReviewService` runs it through
 * `toStoredPlainText` before it reaches the column (see
 * `community-plain-text.ts`), so no markup is ever persisted.
 */
export class CreateCommunityOwnerReviewDto {
  @IsString() @MinLength(20) @MaxLength(2000) reason!: string;
}
