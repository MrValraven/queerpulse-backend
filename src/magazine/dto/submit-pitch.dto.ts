import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import {
  codedValidationMessage,
  MAGAZINE_ERROR_CODE,
  NOT_TEXT_VALIDATION_MESSAGE,
  tooShortValidationMessage,
} from '../magazine-error-codes';

/**
 * Body of `POST /magazine/writer/pitches` (Magazine Desk Phase 6, Task 2).
 * Unlike the editor-side `CreatePitchDto`, there is no `from` field — the
 * pitch is stamped with the authenticated writer's id (`submitterId`) by
 * `MagazinePieceService.submitPitch`, and the editor desk resolves a display
 * name from the writer's account rather than free text.
 *
 * Each constraint carries a magazine code (`codedValidationMessage`), which
 * `MagazineValidationCodeInterceptor` on `MagazineWriterController` surfaces
 * as the 400 body's `code` and `codes`.
 */
export class SubmitPitchDto {
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MinLength(1, {
    message: tooShortValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_PITCH_TITLE_REQUIRED,
    ),
  })
  title!: string;

  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MinLength(1, {
    message: tooShortValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_PITCH_NOTE_REQUIRED,
    ),
  })
  note!: string;

  @IsOptional()
  @IsArray({
    message: codedValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_PITCH_TAGS_INVALID,
      '$property must be an array',
    ),
  })
  @ArrayMaxSize(20, {
    message: codedValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_PITCH_TAGS_TOO_MANY,
      '$property must contain no more than $constraint1 elements',
    ),
  })
  @IsString({
    each: true,
    message: codedValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_PITCH_TAGS_INVALID,
      'each value in $property must be a string',
    ),
  })
  tags?: string[];
}
