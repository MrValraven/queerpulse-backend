import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { SubprofileKind } from './entities/subprofile.entity';
import {
  type PersonaWallPersonaRow,
  toPersonaWallPersona,
  toPersonaWallPick,
  toPersonaWallSearchResult,
} from './persona-wall-response';

// Well-formed storage keys (`persona/<uuid>/<uuid><ext>`): `toImageUrl` drops
// anything that does not parse as one.
const AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';
const COVER_KEY =
  'persona/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg';

const AVATAR_CROP: CropRect = {
  x: 0.1,
  y: 0.1,
  width: 0.5,
  height: 0.5,
  aspect: '1:1',
};
const COVER_CROP: CropRect = {
  x: 0,
  y: 0.2,
  width: 1,
  height: 0.5,
  aspect: '2:1',
};

const CROPS = new Map<string, CropRect>([
  [AVATAR_KEY, AVATAR_CROP],
  [COVER_KEY, COVER_CROP],
]);

function personaRow(
  overrides: Partial<PersonaWallPersonaRow> = {},
): PersonaWallPersonaRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    handle: 'ana-poet',
    displayName: 'Ana Silva',
    kind: SubprofileKind.Musician,
    avatarUrl: null,
    coverUrl: null,
    accent: null,
    ...overrides,
  };
}

describe('persona wall response shaping', () => {
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('uses the avatar, then the cover, then nothing, with the crop that goes with it', () => {
    const avatarPersona = toPersonaWallPersona(
      personaRow({ avatarUrl: AVATAR_KEY, coverUrl: COVER_KEY }),
      CROPS,
    );
    expect(avatarPersona.imageUrl).toBe(toImageUrl(AVATAR_KEY));
    expect(avatarPersona.imageCrop).toEqual(AVATAR_CROP);
    expect(avatarPersona.imageSource).toBe('avatar');

    const coverPersona = toPersonaWallPersona(
      personaRow({ coverUrl: COVER_KEY }),
      CROPS,
    );
    expect(coverPersona.imageUrl).toBe(toImageUrl(COVER_KEY));
    expect(coverPersona.imageCrop).toEqual(COVER_CROP);
    expect(coverPersona.imageSource).toBe('cover');

    const emptyExpectation = {
      imageUrl: null,
      imageCrop: null,
      imageSource: null,
    };
    expect(toPersonaWallPersona(personaRow(), CROPS)).toMatchObject(
      emptyExpectation,
    );
    expect(
      toPersonaWallPersona(personaRow({ avatarUrl: '', coverUrl: '' }), CROPS),
    ).toMatchObject(emptyExpectation);
  });

  it('carries persona fields only, even when the row holds owner fields', () => {
    const rowWithOwnerFields = {
      ...personaRow({ avatarUrl: AVATAR_KEY }),
      userId: '55555555-5555-4555-8555-555555555555',
      linkVisibility: 'linked',
      slug: 'ana-silva',
    } as PersonaWallPersonaRow;
    expect(
      Object.keys(toPersonaWallPersona(rowWithOwnerFields, new Map())).sort(),
    ).toEqual([
      'accent',
      'displayName',
      'handle',
      'id',
      'imageCrop',
      'imageSource',
      'imageUrl',
      'kind',
    ]);
  });

  it('keeps a null handle null', () => {
    expect(
      toPersonaWallPersona(personaRow({ handle: null }), new Map()).handle,
    ).toBeNull();
  });

  it('maps a pick with its position and state', () => {
    const row = personaRow({ avatarUrl: AVATAR_KEY });
    expect(toPersonaWallPick('pick-id-1', 3, row, CROPS, 'not_open')).toEqual({
      id: 'pick-id-1',
      position: 3,
      persona: {
        id: row.id,
        handle: 'ana-poet',
        displayName: 'Ana Silva',
        kind: SubprofileKind.Musician,
        imageUrl: toImageUrl(AVATAR_KEY),
        imageCrop: AVATAR_CROP,
        imageSource: 'avatar',
        accent: null,
      },
      publicState: 'not_open',
    });
  });

  it('marks a picked search result', () => {
    const row = personaRow({ coverUrl: COVER_KEY });
    expect(toPersonaWallSearchResult(row, CROPS, true)).toEqual({
      persona: {
        id: row.id,
        handle: 'ana-poet',
        displayName: 'Ana Silva',
        kind: SubprofileKind.Musician,
        imageUrl: toImageUrl(COVER_KEY),
        imageCrop: COVER_CROP,
        imageSource: 'cover',
        accent: null,
      },
      isPicked: true,
    });
    expect(toPersonaWallSearchResult(row, CROPS, false).isPicked).toBe(false);
  });
});
