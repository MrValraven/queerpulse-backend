import {
  communityAvatarPhotoReference,
  communityCoverPhotoReference,
  eventCoverPhotoReference,
  formatPublicMediaReference,
  forumPostPhotoReference,
  isPublicMediaReference,
  listingCoverPhotoReference,
  listingGalleryPhotoReference,
  listingMenuFileReference,
  listingReviewPhotoReference,
  listingShopItemPhotoReference,
  parsePublicMediaReference,
} from './public-media-reference';
import { mediaReferenceVersion } from './media-reference-version';
import { isMessageAttachmentReference } from './message-attachment-reference';
import { isStorageKey } from './storage-key';

const ROW_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

// SEC-01 / SEC-04: a reference names a row and a place in it, and the
// uploader's user id never appears in one.
describe('public media references', () => {
  it('round-trips every reference kind', () => {
    expect(
      parsePublicMediaReference(forumPostPhotoReference(ROW_ID, 3)!),
    ).toEqual({ kind: 'forum-post-photo', postId: ROW_ID, photoIndex: 3 });
    expect(
      parsePublicMediaReference(listingGalleryPhotoReference(ROW_ID, 11)!),
    ).toEqual({
      kind: 'listing-gallery-photo',
      listingId: ROW_ID,
      photoIndex: 11,
    });
    expect(
      parsePublicMediaReference(listingCoverPhotoReference(ROW_ID)!),
    ).toEqual({ kind: 'listing-cover-photo', listingId: ROW_ID });
    expect(
      parsePublicMediaReference(listingReviewPhotoReference(ROW_ID)!),
    ).toEqual({ kind: 'listing-review-photo', reviewId: ROW_ID });
    expect(
      parsePublicMediaReference(eventCoverPhotoReference(ROW_ID)!),
    ).toEqual({ kind: 'event-cover-photo', eventId: ROW_ID });
    expect(
      parsePublicMediaReference(communityCoverPhotoReference(ROW_ID)!),
    ).toEqual({ kind: 'community-cover-photo', communityId: ROW_ID });
  });

  it('builds nothing from an id that is no uuid', () => {
    expect(forumPostPhotoReference('post-1', 0)).toBeNull();
    expect(listingCoverPhotoReference('')).toBeNull();
    expect(listingGalleryPhotoReference(ROW_ID, -1)).toBeNull();
    expect(forumPostPhotoReference(ROW_ID, 100)).toBeNull();
  });

  it.each([
    `forum-posts/${ROW_ID}/photos/0/..`,
    `forum-posts/${ROW_ID}/photos/123`,
    `forum-posts/not-a-uuid/photos/0`,
    `listings/${ROW_ID}/photos/abc`,
    `listings/${ROW_ID}/cover/extra`,
    `listing-reviews/${ROW_ID}/photos`,
    `/listings/${ROW_ID}/cover`,
    `forum-photos/${ROW_ID}/${ROW_ID}.jpg`,
    `events/${ROW_ID}/covers`,
    `communities/not-a-uuid/cover`,
  ])('rejects the probe %s', (probe) => {
    expect(parsePublicMediaReference(probe)).toBeNull();
  });

  it('never reads as a storage key or a message attachment reference', () => {
    for (const reference of [
      forumPostPhotoReference(ROW_ID, 0)!,
      listingGalleryPhotoReference(ROW_ID, 0)!,
      listingCoverPhotoReference(ROW_ID)!,
      listingReviewPhotoReference(ROW_ID)!,
      eventCoverPhotoReference(ROW_ID)!,
      communityCoverPhotoReference(ROW_ID)!,
    ]) {
      expect(isPublicMediaReference(reference)).toBe(true);
      expect(isStorageKey(reference)).toBe(false);
      expect(isMessageAttachmentReference(reference)).toBe(false);
    }
  });
});

// M4: the serve route checks a token against the canonical reference string,
// so formatting a parsed reference must give back what the builder wrote.
describe('formatPublicMediaReference', () => {
  it('gives back the builder string for every reference kind', () => {
    const references = [
      forumPostPhotoReference(ROW_ID, 3),
      listingGalleryPhotoReference(ROW_ID, 11),
      listingCoverPhotoReference(ROW_ID),
      listingShopItemPhotoReference(ROW_ID, 2),
      listingMenuFileReference(ROW_ID),
      listingReviewPhotoReference(ROW_ID),
      eventCoverPhotoReference(ROW_ID),
      communityCoverPhotoReference(ROW_ID),
      communityAvatarPhotoReference(ROW_ID),
    ];
    for (const reference of references) {
      const parsed = parsePublicMediaReference(reference!);
      expect(parsed).not.toBeNull();
      expect(formatPublicMediaReference(parsed!)).toBe(reference);
    }
  });
});

describe('mediaReferenceVersion', () => {
  const STORED_KEY = `listing-photos/${ROW_ID}/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.webp`;

  it('gives one key two unrelated tokens on two surfaces', () => {
    const coverToken = mediaReferenceVersion(
      STORED_KEY,
      listingCoverPhotoReference(ROW_ID)!,
    );
    const galleryToken = mediaReferenceVersion(
      STORED_KEY,
      listingGalleryPhotoReference(ROW_ID, 0)!,
    );
    expect(coverToken).not.toBe(galleryToken);
  });

  it('is stable for one reference and one stored value', () => {
    const reference = eventCoverPhotoReference(ROW_ID)!;
    expect(mediaReferenceVersion(STORED_KEY, reference)).toBe(
      mediaReferenceVersion(STORED_KEY, reference),
    );
  });
});
