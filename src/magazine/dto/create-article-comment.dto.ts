import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body of `POST /magazine/admin/pieces/:id/comments` (Magazine Desk Phase 7,
 * Task D1 NotesRail "add a note" box). Always creates a top-level comment
 * (`parentId: null` — see `MagazinePieceService.addArticleComment`);
 * `blockId` optionally anchors the note to one article block.
 */
export class CreateArticleCommentDto {
  @IsString() @IsNotEmpty() body!: string;

  @IsOptional() @IsString() blockId?: string;
}
