import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * How many options a poll may carry, and the reasons for both ends.
 *
 * TWO is the floor because a one-option poll asks nothing: there is no choice
 * to express and the only thing a member can do with it is agree, which the
 * upvote on the opening post already covers.
 *
 * SIX is the ceiling because the result bars are read on a phone, where a
 * seventh row pushes the question itself off the screen, and because a poll
 * needing more than six answers is a question that has not been narrowed yet.
 * The vote DTO caps its `optionIds` array at the same number, so a multi-choice
 * ballot naming every option still validates.
 */
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;

/** One answer on the ballot. */
export class CreateThreadPollOptionDto {
  // 60 characters is the column's width (`forum_poll_option.label`).
  //
  // `@Matches(/\S/)` is what actually enforces "non-blank": `@MinLength(1)`
  // happily accepts `'   '`, which stores as an invisible option nobody can
  // pick on purpose and which renders as an empty bar in the results. The
  // service trims what survives, so the stored label is the visible one.
  @IsString()
  @Matches(/\S/, { message: 'each poll option needs a label' })
  @MaxLength(60)
  label!: string;
}

/**
 * The optional poll on `POST /forum/threads`.
 *
 * Validated as a NESTED object (`@ValidateNested` + `@Type`), which is not
 * optional bookkeeping here: the global pipe runs `whitelist: true,
 * forbidNonWhitelisted: true`, and without the `@Type` the nested payload stays
 * a plain object, class-validator skips it, and the whitelist strips every
 * field inside — a poll would arrive as `{}` and be silently dropped.
 *
 * DUPLICATE LABELS are rejected, but in the service rather than here: the
 * comparison has to run against the TRIMMED, case-folded labels the service is
 * about to store, and a decorator that compared the raw strings would pass
 * `['Yes', 'yes ']` and then store two options a reader cannot tell apart.
 */
export class CreateThreadPollDto {
  @IsArray()
  @ArrayMinSize(MIN_POLL_OPTIONS)
  @ArrayMaxSize(MAX_POLL_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => CreateThreadPollOptionDto)
  options!: CreateThreadPollOptionDto[];

  // False (the column's default) means a member picks exactly one option; true
  // lets them pick between one and all of them. Only ever set at creation: a
  // poll that changed its arity after people had voted would be a different
  // question asked of the same ballots.
  @IsOptional()
  @IsBoolean()
  allowMultiple?: boolean;

  // When voting shuts. ISO-8601 on the wire; the WINDOW (strictly future, at
  // most a year out) is enforced in `ForumThreadsService.create`, for the same
  // reason `CreateThreadDto.closesAt` is: a class-validator decorator is
  // evaluated against a clock it cannot see at decoration time.
  //
  // Deliberately independent of the thread's own `closesAt` (see
  // `ForumPoll.closesAt`): a thread can keep taking replies after its poll has
  // closed, and a poll can close first.
  @IsOptional()
  @IsISO8601()
  closesAt?: string;
}
