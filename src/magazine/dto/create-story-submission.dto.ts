import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  codedValidationMessage,
  MAGAZINE_ERROR_CODE,
  NOT_TEXT_VALIDATION_MESSAGE,
  tooLongValidationMessage,
  tooShortValidationMessage,
} from '../magazine-error-codes';

/**
 * Body of `POST /magazine/submissions`. Field names/shape mirror the
 * `SubmitStoryEditor`/`SubmitStoryMeta` FE form (`section` -> `format`,
 * `headline` -> `workingTitle`) and `StorySubmissionResponse` in contracts.ts.
 *
 * `deck`, `body` and `coverImageKey` arrive as their own fields (CON-01). The
 * form used to concatenate deck and body into `pitch` and drop the uploaded
 * cover entirely, so the editor never saw the piece the member actually wrote.
 * `pitch` stays required and stays the SHORT summary: it is what the admin
 * list and the member's own tracker card preview, and every pre-CON-01 row
 * has it.
 *
 * Every constraint carries a magazine code through `codedValidationMessage`,
 * and `MagazineValidationCodeInterceptor` (on `MagazineController`) surfaces
 * it as `code` (first failure) and `codes` (all failures) in the 400 body,
 * beside the unchanged English sentences in `message`.
 */
export class CreateStorySubmissionDto {
  // e.g. one of `SECTIONS` in `submitStory.data.ts` ("Personal essay",
  // "Interview", ...) — not enforced server-side as an enum since the FE
  // section list is editorial config, not a fixed contract.
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MinLength(1, {
    message: tooShortValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_FORMAT_REQUIRED,
    ),
  })
  @MaxLength(100, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_FORMAT_TOO_LONG,
    ),
  })
  format!: string;

  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MinLength(1, {
    message: tooShortValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_WORKING_TITLE_REQUIRED,
    ),
  })
  @MaxLength(200, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_WORKING_TITLE_TOO_LONG,
    ),
  })
  workingTitle!: string;

  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MinLength(1, {
    message: tooShortValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_PITCH_REQUIRED,
    ),
  })
  @MaxLength(5000, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_PITCH_TOO_LONG,
    ),
  })
  pitch!: string;

  /** The standfirst. Optional: a member may submit with no deck. */
  @IsOptional()
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MaxLength(1000, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_DECK_TOO_LONG,
    ),
  })
  deck?: string;

  /**
   * The piece itself. Capped well above the editor's 50-word minimum: a long
   * read runs to thousands of words, and truncating a member's story at the
   * validation boundary would lose the very thing they came to submit.
   */
  @IsOptional()
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MaxLength(120000, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_BODY_TOO_LONG,
    ),
  })
  body?: string;

  /**
   * Storage key of the cover uploaded through `useUploadImage("story-cover")`.
   * `@IsImageReference` keeps a `javascript:`/`data:` URI out of the column,
   * and `StorageKeyOwnershipInterceptor` (strict rule — this handler is NOT on
   * the shared-upload allowlist) refuses a key another member uploaded.
   */
  @IsOptional()
  @IsImageReference({
    message: codedValidationMessage(
      MAGAZINE_ERROR_CODE.STORY_SUBMISSION_COVER_INVALID,
      '$property must be an uploaded image key or an https:// URL on a trusted image host',
    ),
  })
  coverImageKey?: string | null;
}
