import { BadRequestException } from '@nestjs/common';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import type { ListingMenuDietary } from './entities/listing.entity';
import {
  defaultPricingModeForCats,
  healStoredListingMenu,
  normalizeListingMenu,
  toListingMenuView,
} from './listing-menu';

const MENU_KEY =
  'listing-menus/0b8f7c9e-1d2a-4b3c-9e8f-7a6b5c4d3e2f/5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a.pdf';
const PHOTO_KEY =
  'listing-photos/0b8f7c9e-1d2a-4b3c-9e8f-7a6b5c4d3e2f/5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a.webp';

function item(name: string, dietary: ListingMenuDietary[] = []) {
  return { name, price: '2.50', description: '', dietary };
}

/** A wine-list line: the prices are optional and the glass and bottle ones are separate. */
function subsectionItem(
  name: string,
  prices: { price?: string; priceGlass?: string; priceBottle?: string } = {},
) {
  return {
    name,
    price: '',
    ...prices,
    description: '',
    dietary: [] as ListingMenuDietary[],
  };
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
      currency: 'EUR',
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
            price: '2.50',
            description: '',
            dietary: ['vegan', 'glutenFree'],
          },
        ],
        subsections: [],
      },
    ]);
    expect(menu.link).toBe('https://example.pt/menu');
  });

  describe('item prices', () => {
    function menuWithPrice(price: string) {
      return {
        sections: [{ title: 'Coffee', items: [{ ...item('Bica'), price }] }],
      };
    }

    it.each(['3', '2.50', '0.90', '0', '999999.99', ' 2.5 '])(
      'accepts the canonical price %j',
      (price) => {
        expect(() => normalizeListingMenu(menuWithPrice(price))).not.toThrow();
      },
    );

    it('stores the price trimmed', () => {
      expect(
        normalizeListingMenu(menuWithPrice(' 2.5 ')).sections[0]?.items[0]
          ?.price,
      ).toBe('2.5');
    });

    it.each(['2,50', '1000000', '2.505', '.5', '2.'])(
      'rejects the malformed number %j',
      (price) => {
        expect(() => normalizeListingMenu(menuWithPrice(price))).toThrow(
          BadRequestException,
        );
      },
    );

    it('rejects text and a currency sign with the path-prefixed message', () => {
      expect(() => normalizeListingMenu(menuWithPrice('2 EUR'))).toThrow(
        'menu.sections.0.items.0.price must be a number such as 2.50, without a currency sign or text (got "2 EUR")',
      );
    });

    it('numbers the error from the sent arrays, before empty sections drop out', () => {
      expect(() =>
        normalizeListingMenu({
          sections: [
            { title: 'Empty', items: [] },
            {
              title: 'Coffee',
              items: [
                item('Bica'),
                { ...item('Galao'), price: 'market price' },
              ],
            },
          ],
        }),
      ).toThrow(
        'menu.sections.1.items.1.price must be a number such as 2.50, without a currency sign or text (got "market price")',
      );
    });

    it('lets a legacy price through when it is already stored on the listing', () => {
      const storedMenu = {
        sections: [
          {
            title: 'Coffee',
            items: [
              { ...item('Bica'), price: 'market price' },
              { ...item('Galao'), price: ' 4 EUR / 7 EUR ' },
            ],
          },
        ],
      };
      const menu = normalizeListingMenu(
        {
          sections: [
            {
              title: 'Coffee',
              items: [
                { ...item('Bica'), price: 'market price' },
                { ...item('Galao'), price: '4 EUR / 7 EUR' },
              ],
            },
          ],
        },
        storedMenu,
      );
      expect(menu.sections[0]?.items.map((entry) => entry.price)).toEqual([
        'market price',
        '4 EUR / 7 EUR',
      ]);
    });

    it('still rejects new free text when the stored menu holds other legacy prices', () => {
      expect(() =>
        normalizeListingMenu(menuWithPrice('ask the waiter'), {
          sections: [
            {
              title: 'Coffee',
              items: [{ ...item('Bica'), price: 'market price' }],
            },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it('is strict on create, where there is no stored menu', () => {
      expect(() =>
        normalizeListingMenu(menuWithPrice('market price'), undefined),
      ).toThrow(BadRequestException);
    });
  });

  describe('currency', () => {
    it('defaults to EUR when the input has none', () => {
      expect(normalizeListingMenu({ sections: [] }).currency).toBe('EUR');
    });

    it('keeps the currency the input names', () => {
      expect(
        normalizeListingMenu({ sections: [], currency: 'GBP' }).currency,
      ).toBe('GBP');
    });
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

  describe('sub-sections', () => {
    it('trims sub-section titles and item prices and always emits a subsections array', () => {
      const menu = normalizeListingMenu({
        sections: [
          {
            title: ' Wines ',
            items: [],
            subsections: [
              {
                title: ' Red ',
                items: [
                  subsectionItem(' Douro ', {
                    priceGlass: ' 5.50 ',
                    priceBottle: ' 24 ',
                  }),
                ],
              },
            ],
          },
          { title: 'Coffee', items: [item('Bica')] },
        ],
      });
      expect(menu.sections).toEqual([
        {
          title: 'Wines',
          items: [],
          subsections: [
            {
              title: 'Red',
              items: [
                {
                  name: 'Douro',
                  price: '',
                  priceGlass: '5.50',
                  priceBottle: '24',
                  description: '',
                  dietary: [],
                },
              ],
            },
          ],
        },
        {
          title: 'Coffee',
          items: [
            { name: 'Bica', price: '2.50', description: '', dietary: [] },
          ],
          subsections: [],
        },
      ]);
    });

    it('drops a sub-section with no items', () => {
      const menu = normalizeListingMenu({
        sections: [
          {
            title: 'Wines',
            items: [item('House wine')],
            subsections: [
              { title: 'Red', items: [] },
              { title: 'White', items: [subsectionItem('Alvarinho')] },
            ],
          },
        ],
      });
      expect(
        menu.sections[0]?.subsections?.map((entry) => entry.title),
      ).toEqual(['White']);
    });

    it('keeps a section that holds only sub-sections', () => {
      const menu = normalizeListingMenu({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [{ title: 'Red', items: [subsectionItem('Douro')] }],
          },
        ],
      });
      expect(menu.sections).toHaveLength(1);
    });

    it('drops a section whose only sub-sections are empty', () => {
      const menu = normalizeListingMenu({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [{ title: 'Red', items: [] }],
          },
        ],
      });
      expect(menu.sections).toEqual([]);
    });

    it('rejects a sub-section with items and no title, naming its position', () => {
      expect(() =>
        normalizeListingMenu({
          sections: [
            {
              title: 'Wines',
              items: [],
              subsections: [
                { title: 'Red', items: [subsectionItem('Douro')] },
                { title: '  ', items: [subsectionItem('Alvarinho')] },
              ],
            },
          ],
        }),
      ).toThrow(
        'menu.sections.0.subsections.1.title: a sub-section with items needs a title',
      );
    });

    it('rejects an untitled section that holds only sub-sections', () => {
      expect(() =>
        normalizeListingMenu({
          sections: [
            {
              title: '',
              items: [],
              subsections: [{ title: 'Red', items: [subsectionItem('Douro')] }],
            },
          ],
        }),
      ).toThrow(
        'menu.sections.0.title: a menu section with items or sub-sections needs a title',
      );
    });

    it('counts sub-section items toward the 150 item cap', () => {
      const seventyFive = Array.from({ length: 75 }, (_, position) =>
        subsectionItem(`Wine ${position}`),
      );
      expect(() =>
        normalizeListingMenu({
          sections: [
            {
              title: 'Wines',
              items: [],
              subsections: [
                { title: 'Red', items: seventyFive },
                { title: 'White', items: seventyFive },
              ],
            },
            { title: 'Coffee', items: [item('One too many')] },
          ],
        }),
      ).toThrow('menu can hold at most 150 items');
    });

    it('accepts a sub-section item with no price at all', () => {
      expect(() =>
        normalizeListingMenu({
          sections: [
            {
              title: 'Wines',
              items: [],
              subsections: [{ title: 'Red', items: [subsectionItem('Douro')] }],
            },
          ],
        }),
      ).not.toThrow();
    });

    it('still requires a price on a direct item', () => {
      expect(() =>
        normalizeListingMenu({
          sections: [
            { title: 'Coffee', items: [{ ...item('Bica'), price: '' }] },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    function menuWithSubsectionPrices(prices: {
      price?: string;
      priceGlass?: string;
      priceBottle?: string;
    }) {
      return {
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [
              { title: 'Red', items: [subsectionItem('Douro', prices)] },
            ],
          },
        ],
      };
    }

    it('rejects a non-numeric glass price with the path-prefixed message', () => {
      expect(() =>
        normalizeListingMenu(menuWithSubsectionPrices({ priceGlass: '5 EUR' })),
      ).toThrow(
        'menu.sections.0.subsections.0.items.0.priceGlass must be a number such as 12.50, without a currency sign or text (got "5 EUR")',
      );
    });

    it('rejects a non-numeric bottle price with the path-prefixed message', () => {
      expect(() =>
        normalizeListingMenu(
          menuWithSubsectionPrices({ priceBottle: 'ask us' }),
        ),
      ).toThrow(
        'menu.sections.0.subsections.0.items.0.priceBottle must be a number such as 48.00, without a currency sign or text (got "ask us")',
      );
    });

    it('rejects a non-numeric sub-section item price only when it is not blank', () => {
      expect(() =>
        normalizeListingMenu(menuWithSubsectionPrices({ price: '  ' })),
      ).not.toThrow();
      expect(() =>
        normalizeListingMenu(menuWithSubsectionPrices({ price: 'market' })),
      ).toThrow(
        'menu.sections.0.subsections.0.items.0.price must be a number such as 2.50, without a currency sign or text (got "market")',
      );
    });

    it('lets a glass or bottle price through when it is already stored on the listing', () => {
      const storedMenu = {
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [
              {
                title: 'Red',
                items: [
                  {
                    ...subsectionItem('Douro'),
                    price: '',
                    priceGlass: 'house pour',
                    priceBottle: 'ask us',
                    dietary: [],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(() =>
        normalizeListingMenu(
          menuWithSubsectionPrices({
            priceGlass: 'house pour',
            priceBottle: 'ask us',
          }),
          storedMenu,
        ),
      ).not.toThrow();
    });

    it('omits blank glass and bottle keys', () => {
      const menu = normalizeListingMenu(
        menuWithSubsectionPrices({ priceGlass: '  ', priceBottle: '' }),
      );
      const storedItem = menu.sections[0]?.subsections?.[0]?.items[0];
      expect(storedItem).toEqual({
        name: 'Douro',
        price: '',
        description: '',
        dietary: [],
      });
      expect(Object.keys(storedItem ?? {})).not.toContain('priceGlass');
      expect(Object.keys(storedItem ?? {})).not.toContain('priceBottle');
    });

    it('keeps a bottle price alone', () => {
      const menu = normalizeListingMenu(
        menuWithSubsectionPrices({ priceBottle: '48' }),
      );
      expect(menu.sections[0]?.subsections?.[0]?.items[0]).toEqual({
        name: 'Douro',
        price: '',
        priceBottle: '48',
        description: '',
        dietary: [],
      });
    });
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
      currency: 'EUR',
    });
  });

  it('keeps a stored currency', () => {
    expect(toListingMenuView({ currency: 'CHF' }).currency).toBe('CHF');
  });

  it('adds empty subsections to a section saved before sub-sections', () => {
    const view = toListingMenuView({
      sections: [{ title: 'Coffee', items: [item('Bica')] }],
    });
    expect(view.sections).toEqual([
      { title: 'Coffee', items: [item('Bica')], subsections: [] },
    ]);
  });

  it('keeps the stored sub-sections of a section', () => {
    const subsections = [
      { title: 'Red', items: [subsectionItem('Douro', { priceBottle: '24' })] },
    ];
    const view = toListingMenuView({
      sections: [{ title: 'Wines', items: [], subsections }],
    });
    expect(view.sections[0]?.subsections).toEqual(subsections);
  });
});

describe('healStoredListingMenu', () => {
  it('adds the default currency to a stored menu saved before currencies', () => {
    expect(
      healStoredListingMenu({ file: null, link: '', sections: [] }),
    ).toEqual({ sections: [], file: null, link: '', currency: 'EUR' });
  });

  it('keeps a stored currency', () => {
    expect(
      healStoredListingMenu({
        sections: [],
        file: null,
        link: '',
        currency: 'USD',
      }).currency,
    ).toBe('USD');
  });

  it('adds empty subsections to a stored section saved before sub-sections', () => {
    const healed = healStoredListingMenu({
      file: null,
      link: '',
      sections: [{ title: 'Coffee', items: [item('Bica')] }],
    });
    expect(healed.sections).toEqual([
      { title: 'Coffee', items: [item('Bica')], subsections: [] },
    ]);
  });

  it('leaves the stored sub-sections of a section as they are', () => {
    const subsections = [{ title: 'Red', items: [subsectionItem('Douro')] }];
    const healed = healStoredListingMenu({
      file: null,
      link: '',
      sections: [{ title: 'Wines', items: [], subsections }],
    });
    expect(healed.sections[0]?.subsections).toBe(subsections);
  });

  it('heals a legacy stored section to the same shape normalizeListingMenu emits', () => {
    const legacySection = { title: 'Coffee', items: [item('Bica')] };
    const healed = healStoredListingMenu({
      file: null,
      link: '',
      sections: [legacySection],
    });
    const normalized = normalizeListingMenu({
      sections: [legacySection],
    });
    expect(healed.sections).toEqual(normalized.sections);
  });

  it('turns a null stored menu into an empty one', () => {
    expect(healStoredListingMenu(null)).toEqual({
      sections: [],
      file: null,
      link: '',
      currency: 'EUR',
    });
  });
});
