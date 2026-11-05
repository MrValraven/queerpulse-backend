import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import {
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import type {
  CreditCounterpart,
  CreditPersonaIdentity,
} from './subprofile-credit-graph';
import {
  emptyCardCredits,
  toCardCreditsView,
  toMadeTogetherView,
} from './subprofile-credits-response';

// Real storage-key shape: `toImageUrl` drops anything that does not parse as
// one, so a loose stand-in would make the URL assertions pass for the wrong
// reason.
const AVATAR_KEY =
  'work-image/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg';
const ITEM_IMAGE_KEY =
  'work-image/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333.jpg';

function counterpart(
  overrides: Partial<CreditCounterpart> & { identityKey: string },
): CreditCounterpart {
  return {
    kind: 'persona',
    name: overrides.identityKey,
    avatarUrl: null,
    accent: null,
    latestSharedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function persona(
  overrides: Partial<CreditPersonaIdentity> & { id: string },
): CreditPersonaIdentity {
  return {
    handle: overrides.id,
    displayName: `Persona ${overrides.id}`,
    avatarUrl: null,
    accent: null,
    kind: SubprofileKind.Musician,
    status: SubprofileStatus.Published,
    visibility: SubprofileVisibility.Open,
    linkVisibility: SubprofileLinkVisibility.Linked,
    removedAt: null,
    userId: `owner-of-${overrides.id}`,
    isUnderTakedown: false,
    isOwnerBlocked: false,
    ...overrides,
  };
}

describe('subprofile-credits-response', () => {
  beforeEach(() => {
    // `toImageUrl` resolves a storage key only once the base URL is wired.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('emptyCardCredits', () => {
    it('returns a fresh empty value each call', () => {
      const first = emptyCardCredits();
      expect(first).toEqual({ count: 0, faces: [] });
      expect(emptyCardCredits().faces).not.toBe(first.faces);
    });
  });

  describe('toCardCreditsView', () => {
    it('maps faces to the wire shape and resolves stored avatar keys', () => {
      const view = toCardCreditsView({
        count: 4,
        faces: [
          counterpart({
            identityKey: 'persona:ember',
            name: 'Ember',
            avatarUrl: AVATAR_KEY,
            accent: 'coral',
          }),
          counterpart({
            identityKey: 'member:ana',
            kind: 'member',
            name: 'Ana Reis',
          }),
        ],
      });
      expect(view).toEqual({
        count: 4,
        faces: [
          {
            kind: 'persona',
            name: 'Ember',
            avatarUrl: `https://api.test/files/${AVATAR_KEY}`,
            accent: 'coral',
          },
          { kind: 'member', name: 'Ana Reis', avatarUrl: null, accent: null },
        ],
      });
    });

    it('never emits more than three faces, and leaks no identity key or date', () => {
      const view = toCardCreditsView({
        count: 5,
        faces: ['a', 'b', 'c', 'd'].map((id) =>
          counterpart({ identityKey: `persona:${id}` }),
        ),
      });
      expect(view.count).toBe(5);
      expect(view.faces).toHaveLength(3);
      expect(Object.keys(view.faces[0]!).sort()).toEqual([
        'accent',
        'avatarUrl',
        'kind',
        'name',
      ]);
    });
  });

  describe('toMadeTogetherView', () => {
    it('maps an item with author and partner, resolving images and crops', () => {
      const crop: CropRect = {
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.5,
        aspect: '1:1',
      };
      const view = toMadeTogetherView(
        [
          {
            item: {
              id: 'item-1',
              title: 'Night drive',
              imageUrl: ITEM_IMAGE_KEY,
              createdAt: new Date('2026-10-20T10:00:00.000Z'),
            },
            author: persona({
              id: 'author',
              displayName: 'Nightform',
              avatarUrl: AVATAR_KEY,
              accent: 'plum',
            }),
            partner: persona({ id: 'partner', displayName: 'Ember' }),
          },
        ],
        new Map([[ITEM_IMAGE_KEY, crop]]),
      );
      const [made] = view.items;
      expect(made).toMatchObject({
        itemId: 'item-1',
        title: 'Night drive',
        imageUrl: `https://api.test/files/${ITEM_IMAGE_KEY}`,
        imageCrop: crop,
        createdAt: '2026-10-20T10:00:00.000Z',
        author: {
          handle: 'author',
          displayName: 'Nightform',
          kind: SubprofileKind.Musician,
          avatarUrl: `https://api.test/files/${AVATAR_KEY}`,
          accent: 'plum',
        },
        partner: { handle: 'partner', displayName: 'Ember', avatarUrl: null },
      });
    });

    it('carries no owner slug, owner name, link visibility or persona id', () => {
      const view = toMadeTogetherView([
        {
          item: {
            id: 'item-1',
            title: 'Night drive',
            imageUrl: null,
            createdAt: new Date('2026-10-20T10:00:00.000Z'),
          },
          author: persona({ id: 'author' }),
          partner: persona({ id: 'partner' }),
        },
      ]);
      const serialized = JSON.parse(JSON.stringify(view)) as {
        items: Array<{ author: object; partner: object }>;
      };
      for (const side of [
        serialized.items[0]!.author,
        serialized.items[0]!.partner,
      ]) {
        expect(Object.keys(side).sort()).toEqual([
          'accent',
          'avatarUrl',
          'displayName',
          'handle',
          'kind',
        ]);
      }
    });
  });
});
