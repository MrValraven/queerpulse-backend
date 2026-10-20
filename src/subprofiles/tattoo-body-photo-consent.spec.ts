import { BadRequestException } from '@nestjs/common';
import {
  SubprofileSection,
  type ItemStructured,
} from './entities/subprofile-item.entity';
import type { ItemImageCarrier } from './subprofile-item-images';
import {
  assertClientConsentForNewImages,
  findItemNeedingClientConsent,
  storedImageSet,
  structuredForRestoredSnapshot,
} from './tattoo-body-photo-consent';

/** A legacy healed row saved before the consent rule: an image, no flags. */
function legacyRow(imageUrl: string): ItemImageCarrier {
  return { imageUrl, structured: null };
}

describe('storedImageSet', () => {
  it('collects the bare key of every stored image ref', () => {
    const storedImages = storedImageSet([
      { imageUrl: '/files/work-image/u1/a.jpg' },
      {
        imageUrl: 'work-image/u1/after.jpg',
        structured: {
          coverUp: {
            type: 'cover_up',
            beforeImageUrl: 'work-image/u1/before.jpg',
          },
          sessions: [{ imageUrl: 'work-image/u1/s1.jpg' }],
        },
      },
    ]);
    expect([...storedImages].sort()).toEqual([
      'work-image/u1/a.jpg',
      'work-image/u1/after.jpg',
      'work-image/u1/before.jpg',
      'work-image/u1/s1.jpg',
    ]);
  });
});

describe('findItemNeedingClientConsent', () => {
  it('lets a reordered section of legacy healed rows save without consent', () => {
    const storedRows = [
      legacyRow('work-image/u1/a.jpg'),
      legacyRow('work-image/u1/b.jpg'),
      legacyRow('work-image/u1/c.jpg'),
    ];
    const incomingItems = [
      legacyRow('work-image/u1/c.jpg'),
      legacyRow('work-image/u1/a.jpg'),
      legacyRow('work-image/u1/b.jpg'),
    ];
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.Healed,
        incomingItems,
        storedRows,
      ),
    ).toBeNull();
  });

  it('asks consent for a new healed image', () => {
    const storedRows = [legacyRow('work-image/u1/a.jpg')];
    const incomingItems = [
      legacyRow('work-image/u1/a.jpg'),
      { imageUrl: 'work-image/u1/new.jpg', structured: null },
    ];
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.Healed,
        incomingItems,
        storedRows,
      ),
    ).toBe(1);
  });

  it('asks consent when only one session photo is new', () => {
    const storedStructured: ItemStructured = {
      sessions: [
        { imageUrl: 'work-image/u1/s1.jpg' },
        { imageUrl: 'work-image/u1/s2.jpg' },
      ],
    };
    const storedRows: ItemImageCarrier[] = [
      legacyRow('work-image/u1/other.jpg'),
      { imageUrl: 'work-image/u1/main.jpg', structured: storedStructured },
    ];
    const incomingItems: ItemImageCarrier[] = [
      legacyRow('work-image/u1/other.jpg'),
      {
        imageUrl: 'work-image/u1/main.jpg',
        structured: {
          sessions: [
            { imageUrl: 'work-image/u1/s1.jpg' },
            { imageUrl: 'work-image/u1/s2.jpg' },
            { imageUrl: 'work-image/u1/s3.jpg' },
          ],
        },
      },
    ];
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.InProgress,
        incomingItems,
        storedRows,
      ),
    ).toBe(1);
  });

  it('asks consent when only the before photo is new', () => {
    const storedRows: ItemImageCarrier[] = [
      {
        imageUrl: 'work-image/u1/after.jpg',
        structured: {
          coverUp: {
            type: 'cover_up',
            beforeImageUrl: 'work-image/u1/before.jpg',
          },
        },
      },
    ];
    const incomingItems: ItemImageCarrier[] = [
      {
        imageUrl: 'work-image/u1/after.jpg',
        structured: {
          coverUp: {
            type: 'cover_up',
            beforeImageUrl: 'work-image/u1/before-new.jpg',
          },
        },
      },
    ];
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.CoverUps,
        incomingItems,
        storedRows,
      ),
    ).toBe(0);
  });

  it('accepts a new image with hasClientConsent true', () => {
    const incomingItems: ItemImageCarrier[] = [
      {
        imageUrl: 'work-image/u1/new.jpg',
        structured: { photo: { hasClientConsent: true, isBlurred: false } },
      },
    ];
    expect(
      findItemNeedingClientConsent(SubprofileSection.Healed, incomingItems, []),
    ).toBeNull();
  });

  it("reads a hasClientConsent of 'true' as missing", () => {
    const stringConsent = {
      photo: { hasClientConsent: 'true' },
    } as unknown as ItemStructured;
    const incomingItems: ItemImageCarrier[] = [
      legacyRow('work-image/u1/a.jpg'),
      { imageUrl: 'work-image/u1/new.jpg', structured: stringConsent },
    ];
    expect(
      findItemNeedingClientConsent(SubprofileSection.Healed, incomingItems, [
        legacyRow('work-image/u1/a.jpg'),
      ]),
    ).toBe(1);
  });

  it('asks consent again when an image moves to scar_work', () => {
    const movedImageUrl = 'work-image/u1/moved.jpg';
    const healedRows = [legacyRow(movedImageUrl)];
    expect(storedImageSet(healedRows).has(movedImageUrl)).toBe(true);
    const scarWorkRows: ItemImageCarrier[] = [
      {
        imageUrl: 'work-image/u1/scar.jpg',
        structured: { scarWork: { type: 'top_surgery' } },
      },
    ];
    const incomingItems: ItemImageCarrier[] = [
      ...scarWorkRows,
      {
        imageUrl: movedImageUrl,
        structured: { scarWork: { type: 'top_surgery' } },
      },
    ];
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.ScarWork,
        incomingItems,
        scarWorkRows,
      ),
    ).toBe(1);
  });

  it('matches a /files/ key with the bare key', () => {
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.Healed,
        [legacyRow('work-image/u1/a.jpg')],
        [legacyRow('/files/work-image/u1/a.jpg')],
      ),
    ).toBeNull();
  });

  it('leaves wanna_dos and gallery alone', () => {
    const incomingItems = [legacyRow('work-image/u1/new.jpg')];
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.WannaDos,
        incomingItems,
        [],
      ),
    ).toBeNull();
    expect(
      findItemNeedingClientConsent(
        SubprofileSection.Gallery,
        incomingItems,
        [],
      ),
    ).toBeNull();
  });
});

describe('assertClientConsentForNewImages', () => {
  it('throws 400 CLIENT_CONSENT_REQUIRED with itemIndex', () => {
    const incomingItems = [
      legacyRow('work-image/u1/a.jpg'),
      legacyRow('work-image/u1/new.jpg'),
    ];
    const storedRows = [legacyRow('work-image/u1/a.jpg')];
    let thrownError: unknown;
    try {
      assertClientConsentForNewImages(
        SubprofileSection.Healed,
        incomingItems,
        storedRows,
      );
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeInstanceOf(BadRequestException);
    const exception = thrownError as BadRequestException;
    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual(
      expect.objectContaining({
        code: 'CLIENT_CONSENT_REQUIRED',
        itemIndex: 1,
      }),
    );
  });

  it('returns quietly when every image is already stored', () => {
    expect(() =>
      assertClientConsentForNewImages(
        SubprofileSection.Healed,
        [legacyRow('work-image/u1/a.jpg')],
        [legacyRow('work-image/u1/a.jpg')],
      ),
    ).not.toThrow();
  });
});

describe('structuredForRestoredSnapshot', () => {
  it('restores an unstored image without consent as consent false and blurred', () => {
    const snapshot: ItemImageCarrier = {
      imageUrl: 'old.jpg',
      structured: {
        scarWork: { type: 'top_surgery' },
        photo: { isBlurred: false },
      },
    };
    expect(
      structuredForRestoredSnapshot(
        SubprofileSection.ScarWork,
        snapshot,
        new Set<string>(),
      ),
    ).toEqual({
      scarWork: { type: 'top_surgery' },
      photo: { hasClientConsent: false, isBlurred: true },
    });
  });

  it('keeps the snapshot flags when every image is still stored', () => {
    const snapshotStructured: ItemStructured = {
      healed: { healedFor: '2 years' },
      photo: { isBlurred: false },
    };
    const snapshot: ItemImageCarrier = {
      imageUrl: '/files/work-image/u1/a.jpg',
      structured: snapshotStructured,
    };
    expect(
      structuredForRestoredSnapshot(
        SubprofileSection.Healed,
        snapshot,
        new Set(['work-image/u1/a.jpg']),
      ),
    ).toEqual({
      healed: { healedFor: '2 years' },
      photo: { isBlurred: false },
    });
  });

  it('keeps a consented snapshot as it is', () => {
    const snapshot: ItemImageCarrier = {
      imageUrl: 'work-image/u1/gone.jpg',
      structured: {
        scarWork: { type: 'areola' },
        photo: { hasClientConsent: true, isBlurred: false },
      },
    };
    expect(
      structuredForRestoredSnapshot(
        SubprofileSection.ScarWork,
        snapshot,
        new Set<string>(),
      ),
    ).toEqual({
      scarWork: { type: 'areola' },
      photo: { hasClientConsent: true, isBlurred: false },
    });
  });

  it('leaves a restore outside the body-photo sections untouched', () => {
    const snapshot: ItemImageCarrier = {
      imageUrl: 'work-image/u1/flash.jpg',
      structured: { flash: { availability: 'available' } },
    };
    expect(
      structuredForRestoredSnapshot(
        SubprofileSection.Flash,
        snapshot,
        new Set<string>(),
      ),
    ).toEqual({ flash: { availability: 'available' } });
  });
});
