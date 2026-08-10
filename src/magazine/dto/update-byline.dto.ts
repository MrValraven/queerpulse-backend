import { IsString, MinLength } from 'class-validator';

/**
 * Body of `PATCH /magazine/writer/pieces/:id/byline` (Magazine Desk Phase 6,
 * Task 2). `MagazinePieceService.updateMyByline` asserts ownership
 * (`piece.writerId === writerId`) and that the piece isn't already `ready`
 * before applying this.
 */
export class UpdateBylineDto {
  @IsString() @MinLength(1) byline!: string;
}
