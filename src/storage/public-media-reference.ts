import { UUID_SEGMENT } from './storage-key';

// SEC-01 / SEC-04: opaque names for photos whose storage key would otherwise
// reach readers who must not learn who uploaded them. A member storage key is
// `<prefix>/<uploaderUserId>/<uuid><ext>`, and the uploader id in it is the
// same id every avatar URL carries, so a photo on an anonymous forum thread or
// on a listing whose owner chose to stay anonymous would name that person.
//
// Each reference names the ROW that holds the photo and the photo's place in
// it. The key stays out of it:
//
//   forum-posts/<postId>/photos/<index>     a forum post's gallery
//   listings/<listingId>/photos/<index>     a listing's ordered gallery
//   listings/<listingId>/cover              a listing's own cover photo
//   listings/<listingId>/shop-items/<i>/photo  a listing shop item's photo
//   listings/<listingId>/menu               a listing's menu file (PDF or photo)
//   listing-reviews/<reviewId>/photo        a listing review's one photo
//   events/<eventId>/cover                  an event's cover
//   communities/<communityId>/cover         a community's cover
//   communities/<communityId>/avatar        a community's square avatar
//
// `toImageUrl` turns a reference into `<apiBaseUrl>/files/<reference>`, the
// same route a key resolves to. `FilesController` looks the key up from the
// row server-side and streams the bytes, so the key stays on the server and
// out of any redirect's `Location` too. A reference is the same for every
// viewer, which keeps public, CDN-cached reads (the directory) cacheable.
//
// None of these shapes can parse as a storage key or as a message attachment
// reference (`messages/<uuid>/0`): the segment counts and the literal words
// differ, and every id segment is an anchored uuid, so a traversal or probe
// string never parses.

/** Which kind of row a reference names. */
export type PublicMediaReference =
  | { kind: 'forum-post-photo'; postId: string; photoIndex: number }
  | { kind: 'listing-gallery-photo'; listingId: string; photoIndex: number }
  | { kind: 'listing-cover-photo'; listingId: string }
  | { kind: 'listing-shop-item-photo'; listingId: string; itemIndex: number }
  | { kind: 'listing-menu-file'; listingId: string }
  | { kind: 'listing-review-photo'; reviewId: string }
  | { kind: 'event-cover-photo'; eventId: string }
  | { kind: 'community-cover-photo'; communityId: string }
  | { kind: 'community-avatar-photo'; communityId: string };

const FORUM_POST_SEGMENT = 'forum-posts';
const LISTING_SEGMENT = 'listings';
const LISTING_REVIEW_SEGMENT = 'listing-reviews';
const EVENT_SEGMENT = 'events';
const COMMUNITY_SEGMENT = 'communities';

// Up to two digits for a forum post (at most 4 photos today) and three for a
// listing gallery (at most 12), so a reference can never carry an index long
// enough to matter to the database.
const FORUM_POST_PHOTO_PATTERN = new RegExp(
  `^${FORUM_POST_SEGMENT}/(${UUID_SEGMENT})/photos/(\\d{1,2})$`,
);
const LISTING_GALLERY_PHOTO_PATTERN = new RegExp(
  `^${LISTING_SEGMENT}/(${UUID_SEGMENT})/photos/(\\d{1,3})$`,
);
const LISTING_COVER_PHOTO_PATTERN = new RegExp(
  `^${LISTING_SEGMENT}/(${UUID_SEGMENT})/cover$`,
);
// At most six shop items today, so one digit is plenty; two leave headroom.
const LISTING_SHOP_ITEM_PHOTO_PATTERN = new RegExp(
  `^${LISTING_SEGMENT}/(${UUID_SEGMENT})/shop-items/(\\d{1,2})/photo$`,
);
const LISTING_MENU_FILE_PATTERN = new RegExp(
  `^${LISTING_SEGMENT}/(${UUID_SEGMENT})/menu$`,
);
const LISTING_REVIEW_PHOTO_PATTERN = new RegExp(
  `^${LISTING_REVIEW_SEGMENT}/(${UUID_SEGMENT})/photo$`,
);
const EVENT_COVER_PHOTO_PATTERN = new RegExp(
  `^${EVENT_SEGMENT}/(${UUID_SEGMENT})/cover$`,
);
const COMMUNITY_COVER_PHOTO_PATTERN = new RegExp(
  `^${COMMUNITY_SEGMENT}/(${UUID_SEGMENT})/cover$`,
);
const COMMUNITY_AVATAR_PHOTO_PATTERN = new RegExp(
  `^${COMMUNITY_SEGMENT}/(${UUID_SEGMENT})/avatar$`,
);
const UUID_PATTERN = new RegExp(`^${UUID_SEGMENT}$`);

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isPhotoIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < 1000;
}

/** The reference of photo `photoIndex` of forum post `postId`, or `null` when
 *  either part is malformed (a row id is always a uuid in the database). */
export function forumPostPhotoReference(
  postId: string,
  photoIndex: number,
): string | null {
  if (!isUuid(postId) || !isPhotoIndex(photoIndex) || photoIndex > 99) {
    return null;
  }
  return `${FORUM_POST_SEGMENT}/${postId}/photos/${photoIndex}`;
}

/** The reference of gallery photo `photoIndex` of listing `listingId`. */
export function listingGalleryPhotoReference(
  listingId: string,
  photoIndex: number,
): string | null {
  if (!isUuid(listingId) || !isPhotoIndex(photoIndex)) {
    return null;
  }
  return `${LISTING_SEGMENT}/${listingId}/photos/${photoIndex}`;
}

/** The reference of the owner's own cover photo of listing `listingId`. */
export function listingCoverPhotoReference(listingId: string): string | null {
  return isUuid(listingId) ? `${LISTING_SEGMENT}/${listingId}/cover` : null;
}

/** The reference of the photo of shop item `itemIndex` (its place in the
 *  normalized list `toListingShopItemViews` renders) of listing `listingId`. */
export function listingShopItemPhotoReference(
  listingId: string,
  itemIndex: number,
): string | null {
  if (!isUuid(listingId) || !isPhotoIndex(itemIndex) || itemIndex > 99) {
    return null;
  }
  return `${LISTING_SEGMENT}/${listingId}/shop-items/${itemIndex}/photo`;
}

/** The reference of listing `listingId`'s menu file. */
export function listingMenuFileReference(listingId: string): string | null {
  return isUuid(listingId) ? `${LISTING_SEGMENT}/${listingId}/menu` : null;
}

/** The reference of the photo on listing review `reviewId`. */
export function listingReviewPhotoReference(reviewId: string): string | null {
  return isUuid(reviewId)
    ? `${LISTING_REVIEW_SEGMENT}/${reviewId}/photo`
    : null;
}

/** The reference of event `eventId`'s cover. */
export function eventCoverPhotoReference(eventId: string): string | null {
  return isUuid(eventId) ? `${EVENT_SEGMENT}/${eventId}/cover` : null;
}

/** The reference of community `communityId`'s cover. */
export function communityCoverPhotoReference(
  communityId: string,
): string | null {
  return isUuid(communityId)
    ? `${COMMUNITY_SEGMENT}/${communityId}/cover`
    : null;
}

/** The reference of community `communityId`'s square avatar. */
export function communityAvatarPhotoReference(
  communityId: string,
): string | null {
  return isUuid(communityId)
    ? `${COMMUNITY_SEGMENT}/${communityId}/avatar`
    : null;
}

/** The row a reference names, or `null` when the value is not a reference. */
export function parsePublicMediaReference(
  value: string,
): PublicMediaReference | null {
  if (typeof value !== 'string') {
    return null;
  }
  const forumMatch = FORUM_POST_PHOTO_PATTERN.exec(value);
  if (forumMatch?.[1] && forumMatch[2] !== undefined) {
    return {
      kind: 'forum-post-photo',
      postId: forumMatch[1],
      photoIndex: Number(forumMatch[2]),
    };
  }
  const galleryMatch = LISTING_GALLERY_PHOTO_PATTERN.exec(value);
  if (galleryMatch?.[1] && galleryMatch[2] !== undefined) {
    return {
      kind: 'listing-gallery-photo',
      listingId: galleryMatch[1],
      photoIndex: Number(galleryMatch[2]),
    };
  }
  const coverMatch = LISTING_COVER_PHOTO_PATTERN.exec(value);
  if (coverMatch?.[1]) {
    return { kind: 'listing-cover-photo', listingId: coverMatch[1] };
  }
  const shopItemMatch = LISTING_SHOP_ITEM_PHOTO_PATTERN.exec(value);
  if (shopItemMatch?.[1] && shopItemMatch[2] !== undefined) {
    return {
      kind: 'listing-shop-item-photo',
      listingId: shopItemMatch[1],
      itemIndex: Number(shopItemMatch[2]),
    };
  }
  const menuMatch = LISTING_MENU_FILE_PATTERN.exec(value);
  if (menuMatch?.[1]) {
    return { kind: 'listing-menu-file', listingId: menuMatch[1] };
  }
  const reviewMatch = LISTING_REVIEW_PHOTO_PATTERN.exec(value);
  if (reviewMatch?.[1]) {
    return { kind: 'listing-review-photo', reviewId: reviewMatch[1] };
  }
  const eventCoverMatch = EVENT_COVER_PHOTO_PATTERN.exec(value);
  if (eventCoverMatch?.[1]) {
    return { kind: 'event-cover-photo', eventId: eventCoverMatch[1] };
  }
  const communityCoverMatch = COMMUNITY_COVER_PHOTO_PATTERN.exec(value);
  if (communityCoverMatch?.[1]) {
    return {
      kind: 'community-cover-photo',
      communityId: communityCoverMatch[1],
    };
  }
  const communityAvatarMatch = COMMUNITY_AVATAR_PHOTO_PATTERN.exec(value);
  if (communityAvatarMatch?.[1]) {
    return {
      kind: 'community-avatar-photo',
      communityId: communityAvatarMatch[1],
    };
  }
  return null;
}

/**
 * The canonical string of a parsed reference, the same one the builders above
 * produce for it. The serve route hands it to `mediaReferenceVersion` so the
 * token it checks covers the reference identity (surface, row id and slot),
 * exactly as the token a read wrote into the URL does.
 */
export function formatPublicMediaReference(
  reference: PublicMediaReference,
): string {
  switch (reference.kind) {
    case 'forum-post-photo':
      return `${FORUM_POST_SEGMENT}/${reference.postId}/photos/${reference.photoIndex}`;
    case 'listing-gallery-photo':
      return `${LISTING_SEGMENT}/${reference.listingId}/photos/${reference.photoIndex}`;
    case 'listing-cover-photo':
      return `${LISTING_SEGMENT}/${reference.listingId}/cover`;
    case 'listing-shop-item-photo':
      return `${LISTING_SEGMENT}/${reference.listingId}/shop-items/${reference.itemIndex}/photo`;
    case 'listing-menu-file':
      return `${LISTING_SEGMENT}/${reference.listingId}/menu`;
    case 'listing-review-photo':
      return `${LISTING_REVIEW_SEGMENT}/${reference.reviewId}/photo`;
    case 'event-cover-photo':
      return `${EVENT_SEGMENT}/${reference.eventId}/cover`;
    case 'community-cover-photo':
      return `${COMMUNITY_SEGMENT}/${reference.communityId}/cover`;
    case 'community-avatar-photo':
      return `${COMMUNITY_SEGMENT}/${reference.communityId}/avatar`;
  }
}

/** Whether a value is one of the references above. */
export function isPublicMediaReference(value: string): boolean {
  return parsePublicMediaReference(value) !== null;
}
