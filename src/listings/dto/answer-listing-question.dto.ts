import { IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /listings/:ref/questions/:id/answer` body — the listing owner's
 * answer to a moderator's question (item #17). Owner-gated, not
 * moderator-gated (mirrors `ReplyToReviewDto`'s length bounds). */
export class AnswerListingQuestionDto {
  @IsString() @MinLength(1) @MaxLength(2000) answer!: string;
}
