import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for `PATCH /listings/:ref/reviews/:reviewId/reply` — the listing
 * owner's single public reply to a review. Posting again overwrites the
 * previous reply (idempotent update, not a thread); the service trims the
 * text before saving (mirrors `ListingsService`'s other free-text handling).
 * Length bound mirrors `CreateListingReviewDto.text`.
 */
export class ReplyToReviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text!: string;
}
