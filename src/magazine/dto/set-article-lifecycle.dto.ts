import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  ARTICLE_LIFECYCLES,
  ArticleLifecycle,
} from '../entities/magazine-article.entity';

/**
 * `PATCH /magazine/admin/pieces/:id/article/lifecycle` (CON-16).
 *
 * Separate from `PublishArticleDto` on purpose. Publishing answers "can a
 * reader open this?"; lifecycle answers "does the desk still stand by it?".
 * Conflating them is what made unpublishing the only way to retire a piece,
 * which deletes it from the archive and 404s every shared link.
 *
 * Every field is optional so an editor can push the review date out by six
 * months without restating the state, or rewrite the banner note without
 * touching the schedule.
 */
export class SetArticleLifecycleDto {
  /**
   * The new state. Omit to leave it where it is. Moving to `superseded`
   * requires `supersededBySlug` (here or already stored): the banner's whole
   * job in that state is to send the reader to the replacement, and a
   * superseded piece pointing nowhere is worse than no banner at all.
   */
  @IsOptional()
  @IsIn(ARTICLE_LIFECYCLES)
  lifecycle?: ArticleLifecycle;

  /**
   * The editor's own sentence for the reader's banner ("The name-change
   * process changed in March 2026; the section on documents no longer
   * applies"). `''` clears it and the banner falls back to the generic
   * wording for the state.
   *
   * Plain text: it is rendered as a text node, never as markup.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * The scheduled re-review as `YYYY-MM-DD`, or `null` to drop the promise.
   * Past dates are accepted so an editor can backfill "this was due in
   * January and nobody looked", which is exactly what the overdue queue is
   * for. Follows `PublishArticleDto`'s null-widening idiom: `ValidateIf`
   * skips the format check for an explicit `null`.
   */
  @IsOptional()
  @ValidateIf((dto: SetArticleLifecycleDto) => dto.reviewDueOn !== null)
  @IsISO8601()
  reviewDueOn?: string | null;

  /**
   * Slug of the piece that replaces this one, or `null` to unlink it.
   * Addressed by slug rather than uuid because that is what an editor has in
   * front of them (it is in the URL of the replacement they just published).
   */
  @IsOptional()
  @ValidateIf((dto: SetArticleLifecycleDto) => dto.supersededBySlug !== null)
  @IsString()
  @MaxLength(200)
  supersededBySlug?: string | null;
}
