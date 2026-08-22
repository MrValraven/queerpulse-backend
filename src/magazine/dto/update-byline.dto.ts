import { IsString, MaxLength, MinLength } from 'class-validator';

import { DESK_SHORT_TEXT_MAX } from './desk-text-limits';

/**
 * Body of `PATCH /magazine/writer/pieces/:id/byline` (Magazine Desk Phase 6,
 * Task 2). `MagazinePieceService.updateMyByline` asserts ownership
 * (`piece.writerId === writerId`) and that the piece isn't already `ready`
 * before applying this.
 */
export class UpdateBylineDto {
  // Capped (CNT-14): a byline line, not a bio.
  @IsString() @MinLength(1) @MaxLength(DESK_SHORT_TEXT_MAX) byline!: string;
}
