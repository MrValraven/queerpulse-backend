import { IsString, MaxLength, MinLength } from 'class-validator';

import { DESK_SHORT_TEXT_MAX } from './desk-text-limits';
import {
  MAGAZINE_ERROR_CODE,
  NOT_TEXT_VALIDATION_MESSAGE,
  tooLongValidationMessage,
  tooShortValidationMessage,
} from '../magazine-error-codes';

/**
 * Body of `PATCH /magazine/writer/pieces/:id/byline` (Magazine Desk Phase 6,
 * Task 2). `MagazinePieceService.updateMyByline` asserts ownership
 * (`piece.writerId === writerId`) and that the piece isn't already `ready`
 * before applying this.
 */
export class UpdateBylineDto {
  // Capped (CNT-14): a byline line, not a bio.
  // Coded (`codedValidationMessage`); `MagazineValidationCodeInterceptor` on
  // `MagazineWriterController` surfaces the 400 body's `code` and `codes`.
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MinLength(1, {
    message: tooShortValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_BYLINE_REQUIRED,
    ),
  })
  @MaxLength(DESK_SHORT_TEXT_MAX, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_BYLINE_TOO_LONG,
    ),
  })
  byline!: string;
}
