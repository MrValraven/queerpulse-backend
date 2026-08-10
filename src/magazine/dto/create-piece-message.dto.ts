import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /magazine/admin/pieces/:id/messages` and
 * `POST /magazine/writer/pieces/:id/messages` (Magazine Desk Phase 7, Task
 * F1 editor↔writer thread). Both surfaces post the same shape into the same
 * thread — see `MagazinePieceService.postPieceMessage`.
 */
export class CreatePieceMessageDto {
  @IsString() @IsNotEmpty() body!: string;
}
