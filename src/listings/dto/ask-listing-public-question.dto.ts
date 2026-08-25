import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /directory/:slug/questions` — a member asking the business a
 * question IN PUBLIC, for the next reader with the same one.
 *
 * NOT the same thing as `AskListingQuestionDto`, which is the moderator's
 * private question to a submitter during review. Different author, different
 * audience, different table.
 *
 * The 8-character floor is deliberately higher than the 1-character floor on
 * the moderator DTO. A moderator writing "?" is a moderator being terse with
 * someone they are already in a thread with; a member posting "?" on a
 * business's public page is noise the business has to answer or wear.
 */
export class AskListingPublicQuestionDto {
  @IsString() @MinLength(8) @MaxLength(500) body!: string;
}
