import { BadRequestException } from '@nestjs/common';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import {
  defaultPricingModeForCats,
  normalizeListingMenu,
  toListingMenuView,
} from './listing-menu';

const MENU_KEY =
  'listing-menus/0b8f7c9e-1d2a-4b3c-9e8f-7a6b5c4d3e2f/5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a.pdf';
const PHOTO_KEY =
  'listing-photos/0b8f7c9e-1d2a-4b3c-9e8f-7a6b5c4d3e2f/5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a.webp';

function item(name: string, dietary: string[] = []) {
  return { name, price: '2 EUR', description: '', dietary };
}

describe('defaultPricingModeForCats', () => {
  it.each([
    [['food'], 'menu'],
    [['nightlife'], 'menu'],
    [['Food & drink'], 'menu'],
    [['  Bar '], 'menu'],
    [['sauna'], 'menu'],
    [['grooming'], 'services'],
    [[], 'services'],
  ])('%j defaults to %s', (cats, expected) => {
    expect(defaultPricingModeForCats(cats)).toBe(expected);
  });
});

describe('normalizeListingMenu', () => {
  it('returns an empty menu for a missing input', () => {
    expect(normalizeListingMenu(undefined)).toEqual({
      sections: [],
      file: null,
      link: '',
    });
  });

  it('trims text, drops empty sections and orders and de-duplicates dietary labels', () => {
    const menu = normalizeListingMenu({
      sections: [
        {
          title: ' Coffee ',
          items: [item(' Bica ', ['vegan', 'glutenFree', 'vegan'])],
        },
        { title: 'Empty', items: [] },
      ],
      link: ' https://example.pt/menu ',
    });
    expect(menu.sections).toEqual([
      {
        title: 'Coffee',
        items: [
          {
            name: 'Bica',
            price: '2 EUR',
            description: '',
            dietary: ['vegan', 'glutenFree'],
          },
        ],
      },
    ]);
    expect(menu.link).toBe('https://example.pt/menu');
  });

  it('rejects a section that has items and no title', () => {
    expect(() =>
      normalizeListingMenu({
        sections: [{ title: '  ', items: [item('Bica')] }],
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects more than 150 items across all sections', () => {
    const seventyFive = Array.from({ length: 75 }, (_, position) =>
      item(`Item ${position}`),
    );
    expect(() =>
      normalizeListingMenu({
        sections: [
          { title: 'One', items: seventyFive },
          { title: 'Two', items: seventyFive },
          { title: 'Three', items: [item('One too many')] },
        ],
      }),
    ).toThrow(BadRequestException);
  });

  it('stores a listing-menu file as a bare key with a server-derived content type', () => {
    const menu = normalizeListingMenu({
      sections: [],
      file: { url: `/files/${MENU_KEY}`, fileName: ' Menu.pdf ' },
    });
    expect(menu.file).toEqual({
      url: MENU_KEY,
      contentType: 'application/pdf',
      fileName: 'Menu.pdf',
    });
  });

  it('rejects a file key of another upload kind', () => {
    expect(() =>
      normalizeListingMenu({
        sections: [],
        file: { url: PHOTO_KEY, fileName: 'x.webp' },
      }),
    ).toThrow(BadRequestException);
  });

  // `@IsImageReference()` on `ListingMenuFileDto.url` accepts an allowed
  // external image host (unsplash.com and friends): that decorator is
  // shared with fields that DO mean to allow one, like a gallery photo. A
  // menu file is narrower: it must be OUR OWN `listing-menu` upload, so this
  // normalizer is what actually closes off an external URL, the same way it
  // closes off a key of the wrong kind above.
  it('rejects an allowed external image URL, which is not a listing-menu upload', () => {
    expect(() =>
      normalizeListingMenu({
        sections: [],
        file: {
          url: 'https://images.unsplash.com/photo-1',
          fileName: 'menu.jpg',
        },
      }),
    ).toThrow(BadRequestException);
  });
});

describe('toListingMenuView', () => {
  beforeAll(() => setImageUrlBase('https://api.test'));
  afterAll(() => resetImageUrlBaseForTesting());

  it('resolves the stored key to a served URL', () => {
    const view = toListingMenuView({
      sections: [],
      file: {
        url: MENU_KEY,
        contentType: 'application/pdf',
        fileName: 'Menu.pdf',
      },
      link: '',
    });
    expect(view.file?.url).toBe(`https://api.test/files/${MENU_KEY}`);
  });

  it('heals a null or partial stored value into the full shape', () => {
    expect(toListingMenuView(null)).toEqual({
      sections: [],
      file: null,
      link: '',
    });
  });
});
