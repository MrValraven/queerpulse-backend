import { IsBoolean } from 'class-validator';

/**
 * Body of `PATCH /magazine/admin/comments/:commentId/resolve` (Magazine Desk
 * Phase 7, Task D1 NotesRail Resolve toggle). Idempotent — setting the same
 * value twice is a harmless no-op (`MagazinePieceService.resolveArticleComment`).
 */
export class ResolveArticleCommentDto {
  @IsBoolean() resolved!: boolean;
}
