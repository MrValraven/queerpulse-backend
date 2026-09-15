import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * How many photos one forum post may carry.
 *
 * Four, matching the composer's grid: a 2x2 block is the largest arrangement
 * that still reads as one post rather than an album, and a thread page that has
 * to scroll past somebody's gallery to reach the replies is no longer a
 * conversation. The service trims anything past this rather than trusting the
 * DTO alone, the way `MAX_TAGS` is enforced in `ForumThreadsService`.
 */
export const MAX_POST_PHOTOS = 4;

/**
 * One photo attached to a forum post, in the order the author arranged them.
 *
 * `image` is a storage key from the presigned upload pipeline (the
 * `forum-photo` kind), validated by the same `@IsImageReference()` every other
 * image slot uses and re-checked by the global
 * `StorageKeyOwnershipInterceptor`, which refuses a key belonging to somebody
 * else. The array POSITION is the author's ordering and is what gets persisted
 * to `forum_post_photo.position`; there is no `position` field on the wire,
 * because two sources of truth for one ordering is how a gallery ends up
 * rendering in an order nobody chose.
 */
export class ForumPostPhotoDto {
  @IsImageReference()
  image!: string;

  // 280 characters is the column's width, and roughly the length at which alt
  // text stops being a description and becomes the caption it should have been.
  // Optional and stored NULL when absent: alt text is written by a person,
  // often later, and a placeholder auto-filled to satisfy a NOT NULL is worse
  // for a screen reader than no alt at all (see `ForumPostPhoto.alt`).
  @IsOptional()
  @IsString()
  @MaxLength(280)
  alt?: string;
}
