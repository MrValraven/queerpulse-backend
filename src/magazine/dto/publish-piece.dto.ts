import { IsISO8601, IsOptional, ValidateIf } from 'class-validator';

/**
 * `POST /magazine/admin/pieces/:id/publish` body (PRD-119/PRD-120).
 *
 * The unified publish action, for BOTH formats: an `article`-format piece
 * publishes its `MagazineArticle`, a `deck`-format piece publishes its
 * `MagazineDeck`. Same null-widening idiom as `PublishArticleDto` so the two
 * bodies stay interchangeable to a client.
 *
 * Omitted (or an explicit `null`) means "publish now". An ISO instant in the
 * past also publishes now, in the sense that readers see it immediately; an
 * ISO instant in the FUTURE schedules, because a future `publishedAt` is what
 * the public read paths already gate on.
 *
 * There is deliberately no way to UNPUBLISH through this body: taking a live
 * piece back down is `POST /magazine/admin/pieces/:id/unpublish`, which is
 * ungated, so the two acts can never be confused for one another.
 */
export class PublishPieceDto {
  @IsOptional()
  @ValidateIf(
    (publishPiece: PublishPieceDto) => publishPiece.publishedAt !== null,
  )
  @IsISO8601()
  publishedAt?: string | null;
}
