import { BadRequestException } from '@nestjs/common';
import { SubprofileSection } from './entities/subprofile-item.entity';
import {
  assertValidTattooItems,
  findTattooItemViolation,
} from './tattoo-item-validation';
import type { TattooValidatedItem } from './tattoo-item-validation';

const PHOTO_KEY =
  'work/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg';
const OTHER_PHOTO_KEY =
  'work/11111111-2222-3333-4444-555555555555/77777777-8888-9999-0000-111111111111.png';

// Items arrive from the wire, so specs build them as raw wire objects that
// may carry any key or value a client sends.
function buildItem(fields: Record<string, unknown>): TattooValidatedItem {
  return fields;
}

function violationOf(
  section: SubprofileSection,
  fields: Record<string, unknown>,
) {
  return findTattooItemViolation(section, [buildItem(fields)]);
}

function validFlashItem(): Record<string, unknown> {
  return {
    imageUrl: PHOTO_KEY,
    structured: {
      flash: {
        availability: 'claimed',
        size: '8 cm',
        price: '120',
        placements: ['forearm', 'calf'],
      },
    },
  };
}

function sessionsOf(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, sessionIndex) => ({
    imageUrl: PHOTO_KEY,
    date: '2026-10-01',
    note: `Session ${sessionIndex + 1}`,
  }));
}

describe('findTattooItemViolation', () => {
  it('accepts a flash item with availability claimed, size 8 cm, price 120 and two placements', () => {
    expect(violationOf(SubprofileSection.Flash, validFlashItem())).toBeNull();
  });

  it('refuses a flash price of 12.345', () => {
    expect(
      violationOf(SubprofileSection.Flash, {
        structured: { flash: { availability: 'available', price: '12.345' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.flash.price' });
  });

  it('refuses a price on a wanna_dos item', () => {
    expect(
      violationOf(SubprofileSection.WannaDos, {
        imageUrl: PHOTO_KEY,
        structured: {
          flash: { size: 'palm sized', placements: ['thigh'], price: '120' },
        },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.flash.price' });
  });

  it('refuses structured.links on a healed item', () => {
    expect(
      violationOf(SubprofileSection.Healed, {
        imageUrl: PHOTO_KEY,
        structured: {
          healed: { healedFor: '2 years' },
          links: [{ platform: 'instagram', urlOrHandle: '@inked' }],
        },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.links' });
  });

  it('refuses a shop key in the gigs section', () => {
    expect(
      violationOf(SubprofileSection.Gigs, {
        structured: { shop: { type: 'print' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.shop' });
  });

  it('counts a null tattoo key as absent in another section', () => {
    expect(
      violationOf(SubprofileSection.Gigs, { structured: { shop: null } }),
    ).toBeNull();
  });

  it('refuses an unknown photo sub-key', () => {
    expect(
      violationOf(SubprofileSection.Healed, {
        imageUrl: PHOTO_KEY,
        structured: { photo: { isBlurred: false, clientName: 'Sam' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.photo.clientName' });
  });

  it('refuses a skin tone outside the list', () => {
    expect(
      violationOf(SubprofileSection.Healed, {
        imageUrl: PHOTO_KEY,
        structured: { healed: { skinTone: 'olive' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.healed.skinTone' });
  });

  it('requires coverUp and the after photo on a cover_ups item', () => {
    expect(
      violationOf(SubprofileSection.CoverUps, {
        imageUrl: PHOTO_KEY,
        structured: { photo: { hasClientConsent: true } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.coverUp' });
    expect(
      violationOf(SubprofileSection.CoverUps, {
        structured: {
          coverUp: { type: 'cover_up', beforeImageUrl: OTHER_PHOTO_KEY },
        },
      }),
    ).toEqual({ itemIndex: 0, field: 'imageUrl' });
  });

  it('refuses a before photo of javascript:alert(1)', () => {
    expect(
      violationOf(SubprofileSection.CoverUps, {
        imageUrl: PHOTO_KEY,
        structured: {
          coverUp: { type: 'rework', beforeImageUrl: 'javascript:alert(1)' },
        },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.coverUp.beforeImageUrl' });
  });

  it('accepts a cover-up whose before photo reads empty', () => {
    expect(
      violationOf(SubprofileSection.CoverUps, {
        imageUrl: PHOTO_KEY,
        structured: { coverUp: { type: 'cover_up', beforeImageUrl: '' } },
      }),
    ).toBeNull();
  });

  it('refuses thirteen sessions and zero sessions', () => {
    expect(
      violationOf(SubprofileSection.InProgress, {
        imageUrl: PHOTO_KEY,
        structured: { sessions: sessionsOf(13) },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.sessions' });
    expect(
      violationOf(SubprofileSection.InProgress, {
        imageUrl: PHOTO_KEY,
        structured: { sessions: [] },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.sessions' });
  });

  it('refuses a data: session photo at its index', () => {
    const sessions = sessionsOf(5).map((session, sessionIndex) =>
      sessionIndex === 3
        ? { ...session, imageUrl: 'data:image/png;base64,AAAA' }
        : session,
    );
    expect(
      violationOf(SubprofileSection.InProgress, {
        imageUrl: PHOTO_KEY,
        structured: { sessions },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.sessions.3.imageUrl' });
  });

  it('refuses a session note of 281 characters', () => {
    const sessions = sessionsOf(2).map((session, sessionIndex) =>
      sessionIndex === 0 ? { ...session, note: 'n'.repeat(281) } : session,
    );
    expect(
      violationOf(SubprofileSection.InProgress, {
        imageUrl: PHOTO_KEY,
        structured: { sessions },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.sessions.0.note' });
  });

  it('refuses a guest spot ending before it starts', () => {
    expect(
      violationOf(SubprofileSection.GuestSpots, {
        date: '2026-11-03',
        structured: { spot: { type: 'guest_spot', endDate: '2026-11-01' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.spot.endDate' });
  });

  it('refuses a flash day dated 2026-02-30', () => {
    expect(
      violationOf(SubprofileSection.FlashDays, {
        date: '2026-02-30',
        structured: { flashDay: { cause: 'Trans healthcare fund' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'date' });
  });

  it('refuses a cause of 121 characters', () => {
    expect(
      violationOf(SubprofileSection.FlashDays, {
        date: '2026-11-14',
        structured: { flashDay: { cause: 'c'.repeat(121) } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.flashDay.cause' });
  });

  it('refuses a shop link that does not start with https://', () => {
    expect(
      violationOf(SubprofileSection.Shop, {
        url: 'mailto:me@example.com',
        structured: { shop: { type: 'print', price: '25' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'url' });
    expect(
      violationOf(SubprofileSection.Shop, {
        url: 'https://shop.example.com/print',
        structured: { shop: { type: 'print', price: '25' } },
      }),
    ).toBeNull();
  });

  it('refuses a collaborator on a scar_work item', () => {
    expect(
      violationOf(SubprofileSection.ScarWork, {
        imageUrl: PHOTO_KEY,
        collaborators: ['@friend'],
        structured: { scarWork: { type: 'top_surgery' } },
      }),
    ).toEqual({ itemIndex: 0, field: 'collaborators' });
  });

  it('accepts an empty skin tone', () => {
    expect(
      violationOf(SubprofileSection.Healed, {
        imageUrl: PHOTO_KEY,
        structured: { healed: { skinTone: '' } },
      }),
    ).toBeNull();
  });

  it('accepts an empty flash availability', () => {
    expect(
      violationOf(SubprofileSection.Flash, {
        structured: { flash: { availability: '', size: '8 cm' } },
      }),
    ).toBeNull();
  });

  it('refuses a null sub-field', () => {
    expect(
      violationOf(SubprofileSection.Flash, {
        structured: { flash: { size: null } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.flash.size' });
  });

  it('refuses duplicate placements', () => {
    expect(
      violationOf(SubprofileSection.Flash, {
        structured: { flash: { placements: ['forearm', 'forearm'] } },
      }),
    ).toEqual({ itemIndex: 0, field: 'structured.flash.placements.1' });
  });

  it('reports the index of the first bad item', () => {
    expect(
      findTattooItemViolation(SubprofileSection.Flash, [
        buildItem(validFlashItem()),
        buildItem({ structured: { flash: { availability: 'sold' } } }),
      ]),
    ).toEqual({ itemIndex: 1, field: 'structured.flash.availability' });
  });
});

describe('assertValidTattooItems', () => {
  it('throws 400 TATTOO_ITEM_INVALID with itemIndex and field', () => {
    let caught: unknown;
    try {
      assertValidTattooItems(SubprofileSection.Flash, [
        buildItem(validFlashItem()),
        buildItem({ structured: { flash: { price: '12.345' } } }),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const exception = caught as BadRequestException;
    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toMatchObject({
      code: 'TATTOO_ITEM_INVALID',
      itemIndex: 1,
      field: 'structured.flash.price',
    });
  });

  it('returns quietly when every item passes', () => {
    expect(() =>
      assertValidTattooItems(SubprofileSection.Flash, [
        buildItem(validFlashItem()),
      ]),
    ).not.toThrow();
  });
});
