import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { DESK_BLURB_MAX, DESK_SHORT_TEXT_MAX } from './desk-text-limits';

/**
 * Body of `PATCH /magazine/admin/authors/:slug` (staff) and
 * `PATCH /magazine/authors/me` (the linked member's own bio/portrait).
 *
 * Every field is optional and only a PRESENT one is written, so the FE can
 * send just what changed. That matters for `avatarUrl`: re-sending an
 * unchanged portrait somebody else uploaded would otherwise trip the
 * foreign-upload check.
 *
 * `name` is staff-only — see `MagazineService.updateOwnAuthor`, which drops it
 * before applying, since the byline name is what is printed on already
 * published pieces.
 */
export class UpdateAuthorDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(DESK_SHORT_TEXT_MAX)
  name?: string;

  /**
   * The author-page bio and the article's author-bio block. `''` clears it
   * back to NULL (the shape an auto-created byline starts in), so
   * `@MinLength` is deliberately absent.
   */
  @IsOptional()
  @IsString()
  @MaxLength(DESK_BLURB_MAX)
  bio?: string;

  /** Storage key or trusted-host URL; `''`/`null` clears the portrait. */
  @IsOptional()
  @IsImageReference()
  avatarUrl?: string | null;

  /**
   * Staff link/unlink of the member account behind this byline, addressed by
   * PROFILE slug. `null` unlinks. Ignored on the member's own PATCH.
   */
  @IsOptional()
  @IsString()
  @MaxLength(DESK_SHORT_TEXT_MAX)
  memberSlug?: string | null;
}
