import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { ForumPostPhotoDto, MAX_POST_PHOTOS } from './dto/forum-post-photo.dto';
import { ForumPostPhoto } from './entities/forum-post-photo.entity';

/**
 * A photo as the write paths hand it to the database: a bare storage key and
 * the author's alt text, already trimmed and already in the order they will be
 * stored in. `position` is deliberately absent — it is the array index, decided
 * by `insertPostPhotos`, so there is exactly one source of truth for the
 * ordering (see `ForumPostPhotoDto`).
 */
export interface PostPhotoInput {
  storageKey: string;
  alt: string | null;
}

/**
 * `image` and `photos` are the same field spelled twice, so a request carrying
 * BOTH is refused rather than resolved.
 *
 * There is no honest winner to pick. Preferring `photos` silently discards a
 * photo the author attached; preferring `image` discards up to four. And no
 * real client sends both: the old composer knows only `image`, the new one
 * sends every photo in `photos`, including when there is one. Refusing turns a
 * client bug into a 400 the developer sees instead of a photo the member never
 * finds out was dropped.
 *
 * An EMPTY `image` (`''`, the "no photo" value every form sends for an unset
 * slot) is not a second spelling of anything, so `image: '' ` alongside a real
 * `photos` array is fine — that is an edit clearing the legacy column while
 * setting the new rows, which is exactly what it should do.
 */
export function assertSinglePhotoSpelling(
  image: string | undefined,
  photos: ForumPostPhotoDto[] | undefined,
): void {
  if (image && photos && photos.length > 0) {
    throw new BadRequestException(
      'Send either image or photos, not both — photos replaces it',
    );
  }
}

/**
 * Normalizes an author-supplied photo array for storage: drops the entries
 * whose image is empty (`''` is the "no photo" value forms send for an unset
 * slot), trims alt text down to null when it is blank, and caps the result at
 * `MAX_POST_PHOTOS`.
 *
 * The cap is applied HERE as well as on the DTO for the same reason
 * `normalizeTags` re-applies `MAX_TAGS`: this is what actually decides what
 * gets written, and a service reached any other way must not be able to store
 * a sixth photo.
 *
 * Storage keys are NOT rewritten. `StorageKeyOwnershipInterceptor` has already
 * walked the request body, collapsed any resolved `/files/<key>` URL back to
 * the bare key in place, and refused every key the caller does not own — for
 * nested arrays too, which is why `photos[].image` needs nothing of its own
 * here.
 */
export function normalizePostPhotos(
  photos: ForumPostPhotoDto[] | undefined,
): PostPhotoInput[] {
  if (!photos) return [];
  const normalized: PostPhotoInput[] = [];
  for (const photo of photos) {
    const storageKey = photo.image?.trim();
    if (!storageKey) continue;
    const alt = photo.alt?.trim();
    normalized.push({ storageKey, alt: alt ? alt : null });
    if (normalized.length >= MAX_POST_PHOTOS) break;
  }
  return normalized;
}

/**
 * Writes a post's photos in array order, `position` 0..n-1.
 *
 * Takes an `EntityManager` rather than a repository because every caller is
 * already inside a transaction that must include these rows: the thread
 * create transaction for an opening post, the reply transaction for a reply,
 * and the edit transaction for a replacement. A photo row that landed outside
 * its post's transaction would survive a rolled-back post and then violate
 * `FK_forum_post_photo_post_id`.
 */
export async function insertPostPhotos(
  manager: EntityManager,
  postId: string,
  photos: PostPhotoInput[],
): Promise<void> {
  if (!photos.length) return;
  await manager.save(
    photos.map((photo, position) =>
      manager.create(ForumPostPhoto, {
        postId,
        storageKey: photo.storageKey,
        alt: photo.alt,
        position,
      }),
    ),
  );
}

/**
 * Replaces a post's whole photo set: every existing row goes, the supplied ones
 * land in array order.
 *
 * DELETE-THEN-INSERT rather than a diff, deliberately. `position` is unique per
 * post (`UQ_forum_post_photo_post_position`), so reordering four photos by
 * updating them in place walks straight into that constraint halfway through
 * unless the updates are staged through temporary positions. Deleting first
 * makes the reorder trivially correct, and the whole thing is one transaction,
 * so no reader ever observes the gap.
 *
 * The rows deleted here are DATABASE rows only; the objects in the bucket are
 * left alone, matching what `updatePostBody` already does when it clears
 * `image`. Orphaned objects stay listed under the member's own uploads, where
 * they can delete them.
 */
export async function replacePostPhotos(
  manager: EntityManager,
  postId: string,
  photos: PostPhotoInput[],
): Promise<void> {
  await manager.delete(ForumPostPhoto, { postId });
  await insertPostPhotos(manager, postId, photos);
}

/**
 * Every listed post's photos, in ONE query, keyed by post id and ordered by
 * `position` within each post.
 *
 * The ordering is done in SQL rather than in JS because
 * `UQ_forum_post_photo_post_position` leads with `post_id` and then carries
 * `position`, so the index already returns the rows in exactly this order and
 * the sort is free. Empty in, empty out — a page with no posts costs no query
 * at all, the same short-circuit `MemberLookup` and the vote batch use.
 */
export async function photoRowsByPost(
  manager: EntityManager,
  postIds: string[],
): Promise<Map<string, ForumPostPhoto[]>> {
  const byPost = new Map<string, ForumPostPhoto[]>();
  if (!postIds.length) return byPost;
  const rows = await manager.find(ForumPostPhoto, {
    where: { postId: In(postIds) },
    order: { postId: 'ASC', position: 'ASC' },
  });
  for (const row of rows) {
    const existing = byPost.get(row.postId);
    if (existing) {
      existing.push(row);
    } else {
      byPost.set(row.postId, [row]);
    }
  }
  return byPost;
}
