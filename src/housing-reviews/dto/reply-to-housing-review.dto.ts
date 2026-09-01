import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for `PATCH /housing-reviews/:reviewId/reply` — the LISTER's single
 * public reply to a guest's review of their home (PRD-47). Posting again
 * overwrites the previous reply; this is one reply, not a thread.
 *
 * `forbidNonWhitelisted` is on globally, so this class names the whole of what
 * the endpoint accepts. Everything else about the reply (who wrote it, when,
 * which review it hangs off) is derived server-side and is not client input.
 *
 * `@IsNotEmpty` rejects `''` but NOT `' '`, which trims to nothing and would
 * store a reply that renders blank beside a real timestamp. The service
 * re-checks post-trim for exactly that reason, mirroring
 * `ListingsService.replyToReview`.
 *
 * Length bound mirrors the business side's `ReplyToReviewDto`.
 */
export class ReplyToHousingReviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text!: string;
}
