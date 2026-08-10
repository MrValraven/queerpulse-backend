import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /magazine/admin/comments/:commentId/reply` (Magazine Desk
 * Phase 7, Task D1 NotesRail reply box). The reply always inherits its
 * parent's `articleId` and carries no `blockId` of its own — see
 * `MagazinePieceService.replyToArticleComment`.
 */
export class ReplyArticleCommentDto {
  @IsString() @IsNotEmpty() body!: string;
}
