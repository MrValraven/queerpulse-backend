import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { DESK_BLOCK_ID_MAX, DESK_BODY_MAX } from './desk-text-limits';

/**
 * Body of `POST /magazine/admin/pieces/:id/comments` (Magazine Desk Phase 7,
 * Task D1 NotesRail "add a note" box). Always creates a top-level comment
 * (`parentId: null` — see `MagazinePieceService.addArticleComment`);
 * `blockId` optionally anchors the note to one article block.
 */
export class CreateArticleCommentDto {
  // Capped (CNT-14), matching the reader-facing `CreateReaderCommentDto`.
  @IsString() @IsNotEmpty() @MaxLength(DESK_BODY_MAX) body!: string;

  @IsOptional() @IsString() @MaxLength(DESK_BLOCK_ID_MAX) blockId?: string;
}
