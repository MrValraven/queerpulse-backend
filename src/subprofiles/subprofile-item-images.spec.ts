import {
  listItemImageRefs,
  mapItemImageRefs,
  type ItemImageCarrier,
} from './subprofile-item-images';

function buildFullItem(): ItemImageCarrier & { title: string } {
  return {
    title: 'Fern sleeve',
    imageUrl: 'work-image/u1/after.jpg',
    structured: {
      photo: { hasClientConsent: true, isBlurred: false },
      coverUp: {
        type: 'cover_up',
        beforeImageUrl: 'work-image/u1/before.jpg',
      },
      sessions: [
        { imageUrl: 'work-image/u1/s1.jpg' },
        { imageUrl: '' },
        { imageUrl: 'work-image/u1/s1.jpg' },
      ],
    },
  } as ItemImageCarrier & { title: string };
}

function basenameOf(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

describe('subprofile item images', () => {
  it('lists imageUrl, the before photo and every session photo in stored order', () => {
    expect(listItemImageRefs(buildFullItem())).toEqual([
      'work-image/u1/after.jpg',
      'work-image/u1/before.jpg',
      'work-image/u1/s1.jpg',
      'work-image/u1/s1.jpg',
    ]);
  });

  it('lists nothing for an item with no image', () => {
    expect(listItemImageRefs({ imageUrl: null, structured: null })).toEqual([]);
    expect(listItemImageRefs({})).toEqual([]);
    expect(
      listItemImageRefs({
        structured: { coverUp: null, sessions: null },
      }),
    ).toEqual([]);
  });

  it('rewrites every nested ref and leaves the input untouched', () => {
    const item = buildFullItem();
    const frozenCopy = JSON.parse(JSON.stringify(item));
    const result = mapItemImageRefs(
      item,
      (ref) => `persona/p1/${basenameOf(ref)}`,
    );
    expect(result.imageUrl).toBe('persona/p1/after.jpg');
    expect(result.structured?.coverUp?.beforeImageUrl).toBe(
      'persona/p1/before.jpg',
    );
    expect(result.structured?.sessions).toEqual([
      { imageUrl: 'persona/p1/s1.jpg' },
      { imageUrl: '' },
      { imageUrl: 'persona/p1/s1.jpg' },
    ]);
    expect(result.title).toBe(item.title);
    expect(result.structured?.photo).toEqual(item.structured?.photo);
    expect(item).toEqual(frozenCopy);
  });

  it('clears a dropped ref', () => {
    const result = mapItemImageRefs(buildFullItem(), () => null);
    expect(result.imageUrl).toBeNull();
    expect(result.structured?.coverUp?.beforeImageUrl).toBe('');
    expect(result.structured?.sessions).toEqual([
      { imageUrl: '' },
      { imageUrl: '' },
      { imageUrl: '' },
    ]);
  });

  it('passes only non-empty refs to rewrite', () => {
    const rewrite = jest.fn((ref: string) => ref);
    mapItemImageRefs(
      {
        imageUrl: 'a.jpg',
        structured: { sessions: [{ imageUrl: '' }, { imageUrl: 'x.jpg' }] },
      } as ItemImageCarrier,
      rewrite,
    );
    expect(rewrite).toHaveBeenCalledTimes(2);
  });
});
