import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /listings/:ref/public-questions/:id/answer` (the owner) and
 * `POST /admin/listings/:ref/public-questions/:id/answer` (a moderator). One
 * DTO for both: the words are the same shape whoever writes them, and WHO
 * wrote them is recorded on the row, never taken from the body.
 *
 * Length bound mirrors `ReplyToReviewDto`/`AnswerListingQuestionDto` — an
 * answer is allowed to be longer than the question, because "is it step-free"
 * has a one-word answer and "what is your accessibility setup" does not.
 */
export class AnswerListingPublicQuestionDto {
  @IsString() @MinLength(1) @MaxLength(2000) answer!: string;
}
