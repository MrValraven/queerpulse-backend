import {
  MAX_LISTING_GALLERY_PHOTOS,
  galleryFromLegacySlots,
  galleryImageReferences,
  galleryWithLegacySlotPatch,
  legacySlotsFromGallery,
  normalizeGallery,
} from './listing-photo-gallery';

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
