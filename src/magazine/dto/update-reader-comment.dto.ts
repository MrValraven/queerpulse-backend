import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  MAGAZINE_ERROR_CODE,
  NOT_TEXT_VALIDATION_MESSAGE,
  tooLongValidationMessage,
  tooShortValidationMessage,
} from '../magazine-error-codes';

// `PATCH /magazine/comments/:id` body — author-only body edit. Coded the same
// way as `CreateReaderCommentDto`.
export class UpdateReaderCommentDto {
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MinLength(1, {
    message: tooShortValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_READER_COMMENT_BODY_REQUIRED,
    ),
  })
  @MaxLength(10000, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_READER_COMMENT_BODY_TOO_LONG,
    ),
  })
  body!: string;
}
