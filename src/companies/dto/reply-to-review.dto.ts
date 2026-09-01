import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for `PATCH /companies/:slug/reviews/:reviewId/reply` — the EMPLOYER's
 * single public reply to a review of them. Posting again overwrites the
 * previous reply (idempotent update, never a thread).
 *
 * `text` is the only field, and `forbidNonWhitelisted` is global, so anything
 * else in the body is a 400 rather than a silently ignored field.
 *
 * `@IsNotEmpty` rejects `""` but NOT `" "`, so the service re-checks after
 * trimming: a whitespace-only reply would store a real `ownerRepliedAt` beside
 * an `ownerReplyText` that renders blank, stranding the timestamp with no
 * visible reply. Same reason `ListingsService.replyToReview` trims.
 *
 * Length bound mirrors `CreateCompanyReviewDto`'s per-paragraph bound, so the
 * employer's answer can be as long as the paragraph it answers.
 */
export class ReplyToCompanyReviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text!: string;
}
