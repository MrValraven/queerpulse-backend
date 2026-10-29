import {
  LISTING_PHOTO_ZOOM_MAX,
  MAX_LISTING_GALLERY_PHOTOS,
  coverImageReferences,
  galleryFromLegacySlots,
  galleryImageReferences,
  galleryWithFramingPatch,
  galleryWithLegacySlotPatch,
  legacySlotsFromGallery,
  normalizeCoverPhoto,
  normalizeGallery,
  normalizePhotoFraming,
} from './listing-photo-gallery';

const FRONT_FRAMING = { focusX: 0.25, focusY: 0.1, zoom: 1.8 };
const BAR_FRAMING = { focusX: 0.7, focusY: 0.6, zoom: 2.5 };

describe('normalizePhotoFraming', () => {
  it('rounds an in-range framing to four decimals', () => {
    expect(
      normalizePhotoFraming({
        focusX: 0.123456,
        focusY: 0.98765,
        zoom: 1.55555,
      }),
    ).toEqual({ focusX: 0.1235, focusY: 0.9877, zoom: 1.5556 });
  });

  it('clamps focus to 0..1 and zoom to 1..LISTING_PHOTO_ZOOM_MAX', () => {
    expect(
      normalizePhotoFraming({ focusX: -0.2, focusY: 1.4, zoom: 7 }),
    ).toEqual({ focusX: 0, focusY: 1, zoom: LISTING_PHOTO_ZOOM_MAX });
    expect(
      normalizePhotoFraming({ focusX: 0.3, focusY: 0.3, zoom: 0.5 })?.zoom,
    ).toBe(1);
  });

  it('reads the centre at zoom 1 as an unframed photo', () => {
    expect(
      normalizePhotoFraming({ focusX: 0.5, focusY: 0.5, zoom: 1 }),
    ).toBeNull();
    expect(
      normalizePhotoFraming({ focusX: 0.50001, focusY: 0.5, zoom: 1.00002 }),
    ).toBeNull();
  });

  it('uses the centre value for a component that is a non-finite number', () => {
    expect(
      normalizePhotoFraming({
        focusX: Number.NaN,
        focusY: 0.2,
        zoom: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ focusX: 0.5, focusY: 0.2, zoom: 1 });
  });
});

describe('normalizeGallery', () => {
  it('fills in a missing caption and keeps alt text as sent', () => {
    expect(normalizeGallery([{ image: 'a.jpg', alt: 'The bar' }])).toEqual([
      { image: 'a.jpg', alt: 'The bar', caption: '' },
    ]);
  });

  it('preserves the order the owner sent, so the cover stays the cover', () => {
    const gallery = normalizeGallery([
      { image: 'b.jpg', alt: 'B' },
      { image: 'a.jpg', alt: 'A' },
    ]);
    expect(gallery.map((photo) => photo.image)).toEqual(['b.jpg', 'a.jpg']);
  });

  it('drops an entry with no image, which is not a photo', () => {
    const gallery = normalizeGallery([
      { image: '', alt: 'alt text with nothing to describe' },
      { image: 'a.jpg', alt: 'A' },
    ]);
    expect(gallery).toEqual([{ image: 'a.jpg', alt: 'A', caption: '' }]);
  });

  it('caps the list at MAX_LISTING_GALLERY_PHOTOS', () => {
    const oversized = Array.from(
      { length: MAX_LISTING_GALLERY_PHOTOS + 5 },
      (_unused, index) => ({ image: `${index}.jpg`, alt: `Photo ${index}` }),
    );
    expect(normalizeGallery(oversized)).toHaveLength(
      MAX_LISTING_GALLERY_PHOTOS,
    );
  });

  it('carries framing forward by image from the current gallery', () => {
    const currentGallery = [
      { image: 'a.jpg', alt: 'A', caption: '', framing: FRONT_FRAMING },
    ];
    const result = normalizeGallery(
      [
        { image: 'b.jpg', alt: 'B' },
        { image: 'a.jpg', alt: 'A' },
      ],
      currentGallery,
    );
    expect(result[1]?.framing).toEqual(FRONT_FRAMING);
    expect(result[0]).not.toHaveProperty('framing');
  });

  it('drops framing for a photo that left the gallery', () => {
    const currentGallery = [
      { image: 'a.jpg', alt: 'A', caption: '', framing: FRONT_FRAMING },
    ];
    const result = normalizeGallery(
      [{ image: 'b.jpg', alt: 'B' }],
      currentGallery,
    );
    expect(result).toEqual([{ image: 'b.jpg', alt: 'B', caption: '' }]);
  });

  it('takes framing from the current gallery alone, whatever the input entry carries', () => {
    const result = normalizeGallery([
      { image: 'a.jpg', alt: 'A', framing: BAR_FRAMING } as {
        image: string;
        alt: string;
      },
    ]);
    expect(result[0]).not.toHaveProperty('framing');
  });
});

describe('galleryFromLegacySlots', () => {
  it('converts in slot order, skipping empties and carrying alt across', () => {
    const gallery = galleryFromLegacySlots(
      { wide: 'w.jpg', d1: '', d2: 'd2.jpg', vibe: 'v.jpg' },
      { wide: 'Front', d1: 'unused', d2: 'Shelf', vibe: 'Crowd' },
    );
    expect(gallery).toEqual([
      { image: 'w.jpg', alt: 'Front', caption: '' },
      { image: 'd2.jpg', alt: 'Shelf', caption: '' },
      { image: 'v.jpg', alt: 'Crowd', caption: '' },
    ]);
  });

  it('yields an empty gallery when nothing was uploaded', () => {
    expect(galleryFromLegacySlots({}, { wide: 'orphan alt' })).toEqual([]);
  });
});

describe('legacySlotsFromGallery', () => {
  it('projects the first four entries onto the named slots', () => {
    const { photos, alt } = legacySlotsFromGallery([
      { image: '1.jpg', alt: 'One', caption: 'c1' },
      { image: '2.jpg', alt: 'Two', caption: '' },
      { image: '3.jpg', alt: 'Three', caption: '' },
      { image: '4.jpg', alt: 'Four', caption: '' },
      { image: '5.jpg', alt: 'Five', caption: '' },
    ]);
    expect(photos).toEqual({
      wide: '1.jpg',
      d1: '2.jpg',
      d2: '3.jpg',
      vibe: '4.jpg',
    });
    expect(alt).toEqual({
      wide: 'One',
      d1: 'Two',
      d2: 'Three',
      vibe: 'Four',
    });
  });

  it('leaves unfilled slots empty rather than absent', () => {
    const { photos } = legacySlotsFromGallery([
      { image: '1.jpg', alt: 'One', caption: '' },
    ]);
    expect(photos).toEqual({ wide: '1.jpg', d1: '', d2: '', vibe: '' });
  });
});

describe('galleryWithLegacySlotPatch', () => {
  const current = [
    { image: '1.jpg', alt: 'One', caption: 'Since 2019' },
    { image: '2.jpg', alt: 'Two', caption: '' },
    { image: '3.jpg', alt: 'Three', caption: '' },
    { image: '4.jpg', alt: 'Four', caption: '' },
    { image: '5.jpg', alt: 'Five', caption: 'Open studio night' },
  ];

  it('merges one slot without blanking the others', () => {
    const patched = galleryWithLegacySlotPatch(current, { d1: 'new2.jpg' });
    expect(patched.map((photo) => photo.image)).toEqual([
      '1.jpg',
      'new2.jpg',
      '3.jpg',
      '4.jpg',
      '5.jpg',
    ]);
  });

  it('never deletes a photo the old four-slot shape cannot address', () => {
    const patched = galleryWithLegacySlotPatch(current, { wide: 'new1.jpg' });
    expect(patched[4]).toEqual({
      image: '5.jpg',
      alt: 'Five',
      caption: 'Open studio night',
    });
  });

  it('keeps a caption while its photo is unchanged', () => {
    const patched = galleryWithLegacySlotPatch(current, undefined, {
      wide: 'A better description',
    });
    expect(patched[0]).toEqual({
      image: '1.jpg',
      alt: 'A better description',
      caption: 'Since 2019',
    });
  });

  it('drops a caption written for a photo the slot no longer points at', () => {
    const patched = galleryWithLegacySlotPatch(current, { wide: 'new1.jpg' });
    expect(patched[0]).toEqual({
      image: 'new1.jpg',
      alt: 'One',
      caption: '',
    });
  });

  it('removes a cleared slot from the ordered list', () => {
    const patched = galleryWithLegacySlotPatch(current, { d1: '' });
    expect(patched.map((photo) => photo.image)).toEqual([
      '1.jpg',
      '3.jpg',
      '4.jpg',
      '5.jpg',
    ]);
  });

  it('keeps the framing of a photo whose slot still points at it', () => {
    const framedGallery = [
      { image: 'a.jpg', alt: 'A', caption: '', framing: FRONT_FRAMING },
    ];
    const patched = galleryWithLegacySlotPatch(
      framedGallery,
      { wide: 'a.jpg' },
      { wide: 'New alt' },
    );
    expect(patched[0]?.framing).toEqual(FRONT_FRAMING);
    expect(patched[0]?.alt).toBe('New alt');
  });

  it('moves framing with its image when two slots swap', () => {
    const framedGallery = [
      { image: 'a.jpg', alt: 'A', caption: '', framing: FRONT_FRAMING },
      { image: 'b.jpg', alt: 'B', caption: '', framing: BAR_FRAMING },
    ];
    const patched = galleryWithLegacySlotPatch(framedGallery, {
      wide: 'b.jpg',
      d1: 'a.jpg',
    });
    expect(patched.map((photo) => photo.framing)).toEqual([
      BAR_FRAMING,
      FRONT_FRAMING,
    ]);
  });

  it('drops framing when a slot is repointed at a different image', () => {
    const framedGallery = [
      { image: 'a.jpg', alt: 'A', caption: '', framing: FRONT_FRAMING },
    ];
    const patched = galleryWithLegacySlotPatch(framedGallery, {
      wide: 'c.jpg',
    });
    expect(patched[0]).not.toHaveProperty('framing');
  });

  it('leaves the framing on photos past the fourth untouched', () => {
    const framedGallery = current.map((photo, photoIndex) =>
      photoIndex === 4 ? { ...photo, framing: BAR_FRAMING } : photo,
    );
    const patched = galleryWithLegacySlotPatch(framedGallery, {
      wide: 'new1.jpg',
    });
    expect(patched[4]?.framing).toEqual(BAR_FRAMING);
  });
});

describe('galleryWithFramingPatch', () => {
  const photoA = { image: 'a.jpg', alt: 'A', caption: '' };
  const photoB = { image: 'b.jpg', alt: 'B', caption: '' };

  it('sets the framing on every entry that holds the named image', () => {
    const result = galleryWithFramingPatch(
      [photoA, photoB, photoA],
      [{ image: 'a.jpg', framing: FRONT_FRAMING }],
    );
    expect(result.gallery[0]?.framing).toEqual(FRONT_FRAMING);
    expect(result.gallery[2]?.framing).toEqual(FRONT_FRAMING);
    expect(result.gallery[1]).not.toHaveProperty('framing');
    expect(result.unmatchedImages).toEqual([]);
  });

  it('keeps the framing of photos the patch leaves out', () => {
    const result = galleryWithFramingPatch(
      [{ ...photoA, framing: FRONT_FRAMING }, photoB],
      [{ image: 'b.jpg', framing: BAR_FRAMING }],
    );
    expect(result.gallery[0]?.framing).toEqual(FRONT_FRAMING);
    expect(result.gallery[1]?.framing).toEqual(BAR_FRAMING);
  });

  it('removes the framing key when the patch resets a photo to the centre at zoom 1', () => {
    const result = galleryWithFramingPatch(
      [{ ...photoA, framing: FRONT_FRAMING }],
      [{ image: 'a.jpg', framing: { focusX: 0.5, focusY: 0.5, zoom: 1 } }],
    );
    expect(result.gallery[0]).not.toHaveProperty('framing');
  });

  it('clamps and rounds each framing through normalizePhotoFraming', () => {
    const result = galleryWithFramingPatch(
      [photoA],
      [{ image: 'a.jpg', framing: { focusX: 0.123456, focusY: 0.3, zoom: 9 } }],
    );
    expect(result.gallery[0]?.framing).toEqual({
      focusX: 0.1235,
      focusY: 0.3,
      zoom: LISTING_PHOTO_ZOOM_MAX,
    });
    expect(result.gallery[0]?.framing?.zoom).toBe(3);
  });

  it('applies the last entry when the patch names one image twice', () => {
    const result = galleryWithFramingPatch(
      [photoA],
      [
        { image: 'a.jpg', framing: FRONT_FRAMING },
        { image: 'a.jpg', framing: BAR_FRAMING },
      ],
    );
    expect(result.gallery[0]?.framing).toEqual(BAR_FRAMING);
  });

  it('reports every image that matches no entry, once each, in body order', () => {
    const result = galleryWithFramingPatch(
      [photoA],
      [
        { image: 'x.jpg', framing: FRONT_FRAMING },
        { image: 'a.jpg', framing: FRONT_FRAMING },
        { image: 'x.jpg', framing: BAR_FRAMING },
        { image: 'y.jpg', framing: BAR_FRAMING },
      ],
    );
    expect(result.unmatchedImages).toEqual(['x.jpg', 'y.jpg']);
  });

  it('leaves the gallery it was given unmutated', () => {
    const givenGallery = [{ ...photoA, framing: FRONT_FRAMING }, photoB];
    const copyBeforeCall = structuredClone(givenGallery);
    galleryWithFramingPatch(givenGallery, [
      { image: 'a.jpg', framing: BAR_FRAMING },
      { image: 'b.jpg', framing: BAR_FRAMING },
    ]);
    expect(givenGallery).toEqual(copyBeforeCall);
  });
});

describe('galleryImageReferences', () => {
  it('collects every image and tolerates a null gallery', () => {
    expect(
      galleryImageReferences([
        { image: 'a.jpg', alt: '', caption: '' },
        { image: 'b.jpg', alt: '', caption: '' },
      ]),
    ).toEqual(['a.jpg', 'b.jpg']);
    expect(galleryImageReferences(null)).toEqual([]);
    expect(galleryImageReferences(undefined)).toEqual([]);
  });
});

describe('normalizeCoverPhoto', () => {
  it('returns null for null, undefined and an empty image', () => {
    expect(normalizeCoverPhoto(null)).toBeNull();
    expect(normalizeCoverPhoto(undefined)).toBeNull();
    expect(normalizeCoverPhoto({ image: '', alt: 'a terrace' })).toBeNull();
  });

  it('keeps the image and trims the alt text', () => {
    expect(
      normalizeCoverPhoto({
        image: 'listing-covers/u/k.webp',
        alt: '  a terrace  ',
      }),
    ).toEqual({ image: 'listing-covers/u/k.webp', alt: 'a terrace' });
  });

  it('fills a missing alt with the empty string', () => {
    expect(normalizeCoverPhoto({ image: 'listing-covers/u/k.webp' })).toEqual({
      image: 'listing-covers/u/k.webp',
      alt: '',
    });
  });
});

describe('coverImageReferences', () => {
  it('lists the cover image, or nothing', () => {
    expect(
      coverImageReferences({ image: 'listing-covers/u/k.webp', alt: '' }),
    ).toEqual(['listing-covers/u/k.webp']);
    expect(coverImageReferences(null)).toEqual([]);
    expect(coverImageReferences({ image: '', alt: 'x' })).toEqual([]);
  });
});
