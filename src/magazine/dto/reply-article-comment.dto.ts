import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { DESK_BODY_MAX } from './desk-text-limits';

/**
 * Body of `POST /magazine/admin/comments/:commentId/reply` (Magazine Desk
 * Phase 7, Task D1 NotesRail reply box). The reply always inherits its
 * parent's `articleId` and carries no `blockId` of its own — see
 * `MagazinePieceService.replyToArticleComment`.
 */
export class ReplyArticleCommentDto {
  // Capped (CNT-14), same ceiling as the note it replies to.
  @IsString() @IsNotEmpty() @MaxLength(DESK_BODY_MAX) body!: string;
}
