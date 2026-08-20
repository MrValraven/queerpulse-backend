import { IsOptional } from 'class-validator';

/**
 * Body of `POST /magazine/writer/pieces/:id/file` (CNT-6 audit follow-up —
 * the "paste your draft" textarea in `FileDraftModal` used to capture and
 * discard `draftText`, a real data-loss bug). `blocks` is optional (filing
 * with nothing pasted stays a no-body no-op, same as before this DTO
 * existed) and typed `unknown` for the same reason as `UpdateArticleDto.blocks`
 * — the jsonb `ArticleBlock[]` shape is validated by hand
 * (`validateArticleBlocks`), not by class-validator decorators.
 */
export class FileDraftDto {
  @IsOptional()
  blocks?: unknown;
}
