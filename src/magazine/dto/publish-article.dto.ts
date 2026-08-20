import { IsISO8601, IsOptional, ValidateIf } from 'class-validator';

/**
 * `PATCH /magazine/admin/pieces/:id/article/publish` (CNT-1/CNT-2 audit
 * follow-up). Mirrors `UpdatePieceDto.issueId`'s null-widening idiom:
 * `ValidateIf` skips `@IsISO8601()` for an explicit `null`, so a caller can
 * send an ISO instant, `null`, or omit the field entirely. The service
 * (`publishArticle`) reads the field three ways: omitted → publish now, a
 * string → publish at that instant (past or future — scheduling), `null` →
 * unpublish back to draft.
 */
export class PublishArticleDto {
  @IsOptional()
  @ValidateIf(
    (publishArticle: PublishArticleDto) => publishArticle.publishedAt !== null,
  )
  @IsISO8601()
  publishedAt?: string | null;
}
