import { MyMediaUsageResolverImpl } from './my-media-usage.resolver';

function repoReturning(rows: unknown[]) {
  return {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn().mockResolvedValue(rows[0] ?? null),
  } as any;
}

describe('MyMediaUsageResolverImpl', () => {
  const userId = 'user-1';

  it('flags the caller current avatar (raw key) and a listing photo (jsonb)', async () => {
    const avatarKey = `avatars/${userId}/live.jpg`;
    const listingKey = `listing-photos/${userId}/one.jpg`;
    const resolver = new MyMediaUsageResolverImpl(
      repoReturning([{ userId, avatarUrl: avatarKey }]),
      repoReturning([]),
      repoReturning([]),
      repoReturning([]),
      repoReturning([]),
      // Listing.photos is a flat ListingPhotoSet ({ wide, d1, d2, vibe }: string)
      // jsonb column, not a nested `{ photos: { ... } }` map.
      repoReturning([
        {
          ownerId: userId,
          photos: { wide: listingKey, d1: '', d2: '', vibe: '' },
        },
      ]),
    );

    const used = await resolver.resolve(userId, [
      avatarKey,
      listingKey,
      `avatars/${userId}/orphan.jpg`,
    ]);

    expect(used.get(avatarKey)).toBe('profile-photo');
    expect(used.get(listingKey)).toBe('listing');
    expect(used.has(`avatars/${userId}/orphan.jpg`)).toBe(false);
  });

  it('matches a stored /files/<key> URL form', async () => {
    const avatarKey = `avatars/${userId}/live.jpg`;
    const resolver = new MyMediaUsageResolverImpl(
      repoReturning([{ userId, avatarUrl: `/files/${avatarKey}` }]),
      repoReturning([]),
      repoReturning([]),
      repoReturning([]),
      repoReturning([]),
      repoReturning([]),
    );
    const used = await resolver.resolve(userId, [avatarKey]);
    expect(used.has(avatarKey)).toBe(true);
  });
});
