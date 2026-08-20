import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * `PATCH /magazine/admin/pieces/:id/article` (spec §7.3, plan Phase 3
 * Task 3). Every field is optional — the editor autosaves partial patches as
 * the writer types. `blocks` is typed `unknown` on purpose: the jsonb shape
 * (`ArticleBlock[]`) isn't expressible as class-validator decorators, so
 * it's validated by hand via `validateArticleBlocks` in
 * `magazine-article-blocks.validation.ts`, called by the service before
 * `save()` (mirrors the `UpdatePieceDto.brief`/`care` idiom). Publishing is
 * NOT this DTO's job — see `PublishArticleDto`/`PATCH .../article/publish`.
 */
export class UpdateArticleDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  standfirst?: string;

  @IsOptional()
  @IsString()
  kicker?: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  metaDescription?: string;

  @IsOptional()
  @IsString()
  socialImage?: string;

  @IsOptional()
  @IsString()
  canonicalUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contentNotes?: string[];

  @IsOptional()
  blocks?: unknown;
}
