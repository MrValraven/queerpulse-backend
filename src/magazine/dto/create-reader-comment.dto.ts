import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  codedValidationMessage,
  MAGAZINE_ERROR_CODE,
  NOT_TEXT_VALIDATION_MESSAGE,
  tooLongValidationMessage,
  tooShortValidationMessage,
} from '../magazine-error-codes';

// `POST /magazine/articles/:slug/comments` body — a top-level comment, or a
// reply when `parentId` is given (must reference an existing top-level
// comment on the same article; enforced in
// `MagazineReaderCommentsService.create`, not here).
//
// Each constraint carries a magazine code (`codedValidationMessage`), which
// `MagazineValidationCodeInterceptor` on `MagazineController` surfaces as the
// 400 body's `code` and `codes`.
export class CreateReaderCommentDto {
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

  @IsOptional()
  @IsUUID(undefined, {
    message: codedValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_READER_COMMENT_PARENT_ID_INVALID,
      '$property must be a UUID',
    ),
  })
  parentId?: string;
}
