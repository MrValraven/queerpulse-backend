import { BadRequestException } from '@nestjs/common';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ForumPostPhoto } from './entities/forum-post-photo.entity';
import { ForumPost } from './entities/forum-post.entity';
import {
  assertSinglePhotoSpelling,
  insertPostPhotos,
  normalizePostPhotos,
  photoRowsByPost,
  replacePostPhotos,
} from './forum-post-photo';
import { toForumPostResponse, toPostPhotoViews } from './forum-response';

// Two well-formed `forum-photo` storage keys. They have to parse as real keys
// (`isStorageKey`), because `toImageUrl` drops anything that does not — which
// is exactly the behaviour the "resolves to nothing" spec below relies on.
const OWNER = '11111111-1111-4111-8111-111111111111';
const KEY_ONE = `forum-photos/${OWNER}/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg`;
const KEY_TWO = `forum-photos/${OWNER}/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.png`;
const KEY_THREE = `forum-photos/${OWNER}/cccccccc-3333-4333-8333-cccccccccccc.webp`;

// A COMPLETE default typed as `ForumPost` itself, the same rule
// `forum-response.spec.ts` follows: a field the literal omits would widen to
// `X | undefined` and stop being assignable to the entity's `X | null` column.
const postDefaults: ForumPost = {
  id: 'post-1',
  threadId: 'thread-1',
  parentPostId: null,
  authorId: 'author-1',
  body: 'hello',
  image: null,
  voteCount: 0,
  isOp: false,
  createdAt: new Date('2026-09-01T10:00:00Z'),
  editedAt: null,
  deletedAt: null,
  deletedById: null,
};

function makePost(overrides: Partial<ForumPost> = {}): ForumPost {
  return { ...postDefaults, ...overrides };
}

function makeRow(
  id: string,
  storageKey: string,
  position: number,
  alt: string | null = null,
): ForumPostPhoto {
  return {
    id,
    postId: 'post-1',
    storageKey,
    alt,
    position,
    createdAt: new Date('2026-09-01T10:00:00Z'),
  };
}

beforeAll(() => setImageUrlBase('https://api.test'));
afterAll(() => resetImageUrlBaseForTesting());

describe('normalizePostPhotos', () => {
  it('keeps the author ordering and trims alt text', () => {
    expect(
      normalizePostPhotos([
        { image: KEY_TWO, alt: '  a step-free entrance  ' },
        { image: KEY_ONE },
      ]),
    ).toEqual([
      { storageKey: KEY_TWO, alt: 'a step-free entrance' },
      { storageKey: KEY_ONE, alt: null },
    ]);
  });

  it('drops the empty slots a composer sends for an unfilled tile', () => {
    expect(normalizePostPhotos([{ image: '' }, { image: KEY_ONE }])).toEqual([
      { storageKey: KEY_ONE, alt: null },
    ]);
  });

  it('stores blank alt text as null rather than an empty description', () => {
    expect(normalizePostPhotos([{ image: KEY_ONE, alt: '   ' }])).toEqual([
      { storageKey: KEY_ONE, alt: null },
    ]);
  });

  it('caps the set at four even if more arrive', () => {
    const many = [KEY_ONE, KEY_TWO, KEY_THREE, KEY_ONE, KEY_TWO].map(
      (image) => ({ image }),
    );
    expect(normalizePostPhotos(many)).toHaveLength(4);
  });
});

describe('assertSinglePhotoSpelling', () => {
  it('refuses a request that sends image AND photos', () => {
    expect(() =>
      assertSinglePhotoSpelling(KEY_ONE, [{ image: KEY_TWO }]),
    ).toThrow(BadRequestException);
  });

  it('allows an empty image alongside photos — that is an edit clearing the old column', () => {
    expect(() =>
      assertSinglePhotoSpelling('', [{ image: KEY_ONE }]),
    ).not.toThrow();
  });

  it('allows either one on its own', () => {
    expect(() => assertSinglePhotoSpelling(KEY_ONE, undefined)).not.toThrow();
    expect(() =>
      assertSinglePhotoSpelling(undefined, [{ image: KEY_ONE }]),
    ).not.toThrow();
    expect(() => assertSinglePhotoSpelling(undefined, [])).not.toThrow();
  });
});

describe('insertPostPhotos / replacePostPhotos ordering', () => {
  function managerStub() {
    return {
      create: jest
        .fn()
        .mockImplementation((_entity: unknown, row: unknown) => row),
      save: jest.fn().mockImplementation((rows: unknown) => rows),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      find: jest.fn().mockResolvedValue([]),
    };
  }

  it('numbers position from the array index, 0-based', async () => {
    const manager = managerStub();
    await insertPostPhotos(manager as never, 'post-1', [
      { storageKey: KEY_ONE, alt: 'first' },
      { storageKey: KEY_TWO, alt: null },
      { storageKey: KEY_THREE, alt: null },
    ]);
    expect(manager.save).toHaveBeenCalledWith([
      { postId: 'post-1', storageKey: KEY_ONE, alt: 'first', position: 0 },
      { postId: 'post-1', storageKey: KEY_TWO, alt: null, position: 1 },
      { postId: 'post-1', storageKey: KEY_THREE, alt: null, position: 2 },
    ]);
  });

  it('writes nothing at all for an empty set', async () => {
    const manager = managerStub();
    await insertPostPhotos(manager as never, 'post-1', []);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('replace clears the old rows BEFORE inserting, so a reorder cannot collide', async () => {
    const manager = managerStub();
    const order: string[] = [];
    manager.delete.mockImplementation(() => {
      order.push('delete');
      return Promise.resolve({ affected: 2 });
    });
    manager.save.mockImplementation((rows: unknown) => {
      order.push('save');
      return rows;
    });
    await replacePostPhotos(manager as never, 'post-1', [
      // The same two photos the post already had, swapped: an in-place update
      // would hit `UQ_forum_post_photo_post_position` halfway through.
      { storageKey: KEY_TWO, alt: null },
      { storageKey: KEY_ONE, alt: null },
    ]);
    expect(order).toEqual(['delete', 'save']);
    expect(manager.delete).toHaveBeenCalledWith(ForumPostPhoto, {
      postId: 'post-1',
    });
  });

  it('replace with an empty set leaves the post with no rows and no insert', async () => {
    const manager = managerStub();
    await replacePostPhotos(manager as never, 'post-1', []);
    expect(manager.delete).toHaveBeenCalledTimes(1);
    expect(manager.save).not.toHaveBeenCalled();
  });
});

describe('photoRowsByPost', () => {
  it('asks the database for the ordering rather than sorting in memory', async () => {
    const manager = {
      find: jest.fn().mockResolvedValue([]),
    };
    await photoRowsByPost(manager as never, ['post-1', 'post-2']);
    expect(manager.find).toHaveBeenCalledWith(
      ForumPostPhoto,
      expect.objectContaining({
        order: { postId: 'ASC', position: 'ASC' },
      }),
    );
  });

  it('groups by post, one query for the whole page', async () => {
    const manager = {
      find: jest
        .fn()
        .mockResolvedValue([
          makeRow('photo-1', KEY_ONE, 0),
          makeRow('photo-2', KEY_TWO, 1),
          { ...makeRow('photo-3', KEY_THREE, 0), postId: 'post-2' },
        ]),
    };
    const byPost = await photoRowsByPost(manager as never, [
      'post-1',
      'post-2',
    ]);
    expect(manager.find).toHaveBeenCalledTimes(1);
    expect(byPost.get('post-1')?.map((row) => row.id)).toEqual([
      'photo-1',
      'photo-2',
    ]);
    expect(byPost.get('post-2')?.map((row) => row.id)).toEqual(['photo-3']);
  });

  it('costs no query at all for an empty page', async () => {
    const manager = { find: jest.fn() };
    const byPost = await photoRowsByPost(manager as never, []);
    expect(manager.find).not.toHaveBeenCalled();
    expect(byPost.size).toBe(0);
  });
});

describe('toPostPhotoViews — the legacy image lives alongside the rows', () => {
  it('renders a post that has only the legacy image as a one-photo gallery', () => {
    const views = toPostPhotoViews(makePost({ image: KEY_ONE }), []);
    expect(views).toEqual([
      // `id` is null because there is no `forum_post_photo` row behind it —
      // that null IS the back-compat marker.
      { id: null, url: `https://api.test/files/${KEY_ONE}`, alt: null },
    ]);
  });

  it('prefers the rows when a post has them, in position order', () => {
    const views = toPostPhotoViews(makePost({ image: KEY_ONE }), [
      makeRow('photo-1', KEY_TWO, 0, 'the lease'),
      makeRow('photo-2', KEY_THREE, 1),
    ]);
    expect(views.map((view) => view.id)).toEqual(['photo-1', 'photo-2']);
    expect(views.map((view) => view.url)).toEqual([
      `https://api.test/files/${KEY_TWO}`,
      `https://api.test/files/${KEY_THREE}`,
    ]);
    expect(views[0]?.alt).toBe('the lease');
  });

  it('is empty for a post with neither', () => {
    expect(toPostPhotoViews(makePost(), [])).toEqual([]);
  });

  it('leaves out a photo whose stored value resolves to nothing', () => {
    // A legacy value that is neither one of our keys nor an allowed https URL
    // is dropped by `toImageUrl`, and a dropped photo must not survive as a
    // null-url entry a client would try to render.
    expect(
      toPostPhotoViews(makePost({ image: 'javascript:alert(1)' }), []),
    ).toEqual([]);
  });
});

describe('toForumPostResponse — image and photos never disagree', () => {
  const viewer = { userId: 'author-1', isModerator: false };

  it('answers the legacy `image` field from the head of the new gallery', () => {
    const dto = toForumPostResponse(
      makePost(),
      null,
      0,
      viewer,
      undefined,
      null,
      null,
      [makeRow('photo-1', KEY_TWO, 0), makeRow('photo-2', KEY_THREE, 1)],
    );
    // A client that predates `photos` still gets a real photo out of a post
    // written by the new composer, instead of the null the raw column holds.
    expect(dto.image).toBe(`https://api.test/files/${KEY_TWO}`);
    expect(dto.photos).toHaveLength(2);
    expect(dto.image).toBe(dto.photos[0]?.url);
  });

  it('is byte-for-byte what it always was for a post holding only the old column', () => {
    const dto = toForumPostResponse(
      makePost({ image: KEY_ONE }),
      null,
      0,
      viewer,
    );
    expect(dto.image).toBe(`https://api.test/files/${KEY_ONE}`);
    expect(dto.photos).toEqual([
      { id: null, url: `https://api.test/files/${KEY_ONE}`, alt: null },
    ]);
  });

  it('blanks both on a tombstoned post — a photo is content', () => {
    const dto = toForumPostResponse(
      makePost({ image: KEY_ONE, deletedAt: new Date() }),
      null,
      0,
      viewer,
      undefined,
      null,
      null,
      [makeRow('photo-1', KEY_TWO, 0)],
    );
    expect(dto.image).toBeNull();
    expect(dto.photos).toEqual([]);
  });

  it('blanks both under a moderator takedown too', () => {
    const dto = toForumPostResponse(
      makePost({ image: KEY_ONE }),
      null,
      0,
      viewer,
      { hidden: false, removed: true },
      null,
      null,
      [makeRow('photo-1', KEY_TWO, 0)],
    );
    expect(dto.image).toBeNull();
    expect(dto.photos).toEqual([]);
  });
});
