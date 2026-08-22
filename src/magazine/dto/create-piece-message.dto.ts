import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { DESK_BODY_MAX } from './desk-text-limits';

/**
 * Body of `POST /magazine/admin/pieces/:id/messages` and
 * `POST /magazine/writer/pieces/:id/messages` (Magazine Desk Phase 7, Task
 * F1 editor↔writer thread). Both surfaces post the same shape into the same
 * thread — see `MagazinePieceService.postPieceMessage`.
 */
export class CreatePieceMessageDto {
  // Capped (CNT-14): the thread is also fanned out as notifications, so an
  // unbounded body is delivered far beyond the row it was stored in.
  @IsString() @IsNotEmpty() @MaxLength(DESK_BODY_MAX) body!: string;
}
