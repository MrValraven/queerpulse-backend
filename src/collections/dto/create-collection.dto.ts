import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/** Body for `POST /me/collections` — names a new (empty) collection. */
export class CreateCollectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  /**
   * Optional cover image. `@IsImageReference()` bounds it to one of our own
   * storage keys or an `https://` URL on a trusted host, which is what every
   * other image field in the codebase gets; it replaces a plain
   * `@IsString() @MaxLength(200)` that accepted a `javascript:` or `data:` URI
   * and any third-party host, and whose 200-character cap is subsumed by the
   * decorator's own limit.
   *
   * The entity comment calls this "a cover colour/image key", but no colour
   * token has ever reached it: `BackfillCollectionsIntoSavedLists` recorded
   * that no UI has ever written `cover` at all (the frontend's create and
   * rename calls send `{ name }` only, so every stored row's `cover` is NULL),
   * and the successor `saved_lists` has no cover column to inherit one. So
   * nothing is broken by refusing a non-image value here.
   *
   * This module is DEPRECATED (SOC-12) and its write endpoints are still
   * mounted, which is exactly why the validation matters: a superseded surface
   * that still accepts unvalidated writes is the one nobody re-audits.
   */
  @IsOptional()
  @IsImageReference()
  cover?: string;
}
