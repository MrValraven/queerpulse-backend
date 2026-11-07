import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { DESK_BODY_MAX } from './desk-text-limits';
import {
  codedValidationMessage,
  MAGAZINE_ERROR_CODE,
  NOT_TEXT_VALIDATION_MESSAGE,
  tooLongValidationMessage,
} from '../magazine-error-codes';

/**
 * Body of `POST /magazine/admin/pieces/:id/messages` and
 * `POST /magazine/writer/pieces/:id/messages` (Magazine Desk Phase 7, Task
 * F1 editor↔writer thread). Both surfaces post the same shape into the same
 * thread — see `MagazinePieceService.postPieceMessage`.
 */
export class CreatePieceMessageDto {
  // Capped (CNT-14): the thread is also fanned out as notifications, so an
  // unbounded body is delivered far beyond the row it was stored in.
  //
  // Coded (`codedValidationMessage`); `MagazineValidationCodeInterceptor` on
  // both controllers surfaces the 400 body's `code` and `codes`.
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @IsNotEmpty({
    message: codedValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_PIECE_MESSAGE_REQUIRED,
      '$property should not be empty',
    ),
  })
  @MaxLength(DESK_BODY_MAX, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.MAGAZINE_PIECE_MESSAGE_TOO_LONG,
    ),
  })
  body!: string;
}
