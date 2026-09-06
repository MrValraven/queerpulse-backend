import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/**
 * How a filing meets the blocks the article draft already holds.
 *
 * `append` is the default and what filing has always done: the pasted draft is
 * added after whatever is there. `replace` makes the filed text the whole body,
 * which is the only way a writer can correct something they already filed
 * (PRD-122). The pre-replace body is snapshotted as an article version first,
 * so a replace is always recoverable from the VersionsRail.
 */
export const FILE_DRAFT_MODES = ['append', 'replace'] as const;
export type FileDraftMode = (typeof FILE_DRAFT_MODES)[number];

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

  /**
   * The article `version` the writer's client last read (see
   * `MagazineArticle.version`). Filing appends to the SAME row an editor may be
   * editing, so without this the append can land on top of an editor's autosave
   * and lose it. When present, a stale value is refused with 409.
   *
   * Optional for the same staged-rollout reason as
   * `UpdateArticleDto.expectedVersion`.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;

  /**
   * What to do with `blocks` against the draft that already exists. Omitted
   * means `append`, so an older client keeps its exact previous behaviour.
   * Ignored when `blocks` is absent.
   */
  @IsOptional()
  @IsIn(FILE_DRAFT_MODES)
  mode?: FileDraftMode;
}
