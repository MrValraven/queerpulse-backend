import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { CreateListingDto } from './create-listing.dto';

async function menuErrors(menu: unknown, pricingMode?: unknown) {
  const dto = plainToInstance(CreateListingDto, { menu, pricingMode });
  const errors = await validate(dto, { skipMissingProperties: true });
  return errors.filter(
    (error) => error.property === 'menu' || error.property === 'pricingMode',
  );
}

describe('CreateListingDto menu', () => {
  it('accepts a sectioned menu with dietary labels, an empty link and no file', async () => {
    expect(
      await menuErrors(
        {
          sections: [
            {
              title: 'Coffee',
              items: [
                {
                  name: 'Bica',
                  price: '0.90',
                  description: '',
                  dietary: ['vegan'],
                },
              ],
            },
          ],
          file: null,
          link: '',
        },
        'menu',
      ),
    ).toHaveLength(0);
  });

  it('accepts a supported currency', async () => {
    expect(await menuErrors({ sections: [], currency: 'GBP' })).toHaveLength(0);
  });

  it('rejects a currency outside the supported six', async () => {
    expect(
      await menuErrors({ sections: [], currency: 'JPY' }),
    ).not.toHaveLength(0);
  });

  it('rejects an unknown pricing mode', async () => {
    expect(await menuErrors(undefined, 'catalogue')).not.toHaveLength(0);
  });

  it('rejects an unknown dietary label', async () => {
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Coffee',
            items: [{ name: 'Bica', price: '1', dietary: ['halal'] }],
          },
        ],
      }),
    ).not.toHaveLength(0);
  });

  it('rejects an item with no price', async () => {
    expect(
      await menuErrors({
        sections: [{ title: 'Coffee', items: [{ name: 'Bica', price: '' }] }],
      }),
    ).not.toHaveLength(0);
  });

  it('rejects a description over 200 characters', async () => {
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Coffee',
            items: [{ name: 'Bica', price: '1', description: 'x'.repeat(201) }],
          },
        ],
      }),
    ).not.toHaveLength(0);
  });

  it('rejects a thirteenth section', async () => {
    const section = { title: 'S', items: [] };
    expect(
      await menuErrors({ sections: Array.from({ length: 13 }, () => section) }),
    ).not.toHaveLength(0);
  });

  it('accepts a sub-section item with only a glass price', async () => {
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [
              {
                title: 'Red',
                items: [{ name: 'Douro', priceGlass: '5.50' }],
              },
            ],
          },
        ],
      }),
    ).toHaveLength(0);
  });

  it('accepts a sub-section item with glass and bottle prices and no price', async () => {
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [
              {
                title: 'Red',
                items: [
                  { name: 'Douro', priceGlass: '5.50', priceBottle: '24' },
                ],
              },
            ],
          },
        ],
      }),
    ).toHaveLength(0);
  });

  it('rejects a sub-section item with no name', async () => {
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [
              { title: 'Red', items: [{ name: '', priceGlass: '5' }] },
            ],
          },
        ],
      }),
    ).not.toHaveLength(0);
  });

  it('rejects a ninth sub-section in one section', async () => {
    const subsection = { title: 'S', items: [] };
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: Array.from({ length: 9 }, () => subsection),
          },
        ],
      }),
    ).not.toHaveLength(0);
  });

  it('accepts eight sub-sections in one section', async () => {
    const subsection = { title: 'S', items: [] };
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: Array.from({ length: 8 }, () => subsection),
          },
        ],
      }),
    ).toHaveLength(0);
  });

  it('rejects a glass price over 80 characters', async () => {
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [
              {
                title: 'Red',
                items: [{ name: 'Douro', priceGlass: '1'.repeat(81) }],
              },
            ],
          },
        ],
      }),
    ).not.toHaveLength(0);
  });

  it('rejects a bottle price over 80 characters', async () => {
    expect(
      await menuErrors({
        sections: [
          {
            title: 'Wines',
            items: [],
            subsections: [
              {
                title: 'Red',
                items: [{ name: 'Douro', priceBottle: '1'.repeat(81) }],
              },
            ],
          },
        ],
      }),
    ).not.toHaveLength(0);
  });

  it('rejects a javascript: link', async () => {
    expect(
      await menuErrors({ sections: [], link: 'javascript:alert(1)' }),
    ).not.toHaveLength(0);
  });

  it('rejects an empty file url', async () => {
    expect(
      await menuErrors({
        sections: [],
        file: { url: '', fileName: 'menu.pdf' },
      }),
    ).not.toHaveLength(0);
  });
});

// The real global pipe (`whitelist: true, forbidNonWhitelisted: true`), not
// the loose `validate()` helper above: `ListingMenuFileDto` declares only
// `url`/`fileName`, so a body whose file also carries `contentType` (what the
// frontend used to send straight back from a GET) must 400 rather than pass
// through `menuErrors`'s narrower check.
describe('CreateListingDto menu through the real ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: CreateListingDto,
  };
  const MENU_KEY =
    'listing-menus/0b8f7c9e-1d2a-4b3c-9e8f-7a6b5c4d3e2f/5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a.pdf';

  function bodyWithMenuFile(file: Record<string, unknown> | null) {
    return {
      path: 'suggest',
      name: 'Café X',
      cats: ['food'],
      hood: 'Arroios',
      blurb: 'A queer café',
      whatItIs: [{ id: 'w1', text: 'Café' }],
      address: 'Rua X 1',
      latitude: 38.7167,
      longitude: -9.149,
      affirmingBaselineAccepted: true,
      menu: { sections: [], file, link: '' },
    };
  }

  it('passes a menu file carrying only url and fileName', async () => {
    const transformed = (await pipe.transform(
      bodyWithMenuFile({ url: MENU_KEY, fileName: 'Menu.pdf' }),
      metadata,
    )) as CreateListingDto;
    expect(transformed.menu?.file).toEqual({
      url: MENU_KEY,
      fileName: 'Menu.pdf',
    });
  });

  it('whitelists the menu currency instead of refusing it as an unknown field', async () => {
    const transformed = (await pipe.transform(
      {
        ...bodyWithMenuFile(null),
        menu: { sections: [], link: '', currency: 'BRL' },
      },
      metadata,
    )) as CreateListingDto;
    expect(transformed.menu?.currency).toBe('BRL');
  });

  it('passes a sub-section item carrying only a glass price', async () => {
    const transformed = (await pipe.transform(
      {
        ...bodyWithMenuFile(null),
        menu: {
          sections: [
            {
              title: 'Wines',
              items: [],
              subsections: [
                {
                  title: 'Red',
                  items: [{ name: 'Douro', priceGlass: '5.50' }],
                },
              ],
            },
          ],
          link: '',
        },
      },
      metadata,
    )) as CreateListingDto;
    expect(
      transformed.menu?.sections[0]?.subsections?.[0]?.items[0]?.priceGlass,
    ).toBe('5.50');
  });

  it('rejects a direct item carrying a glass price, with a 400', async () => {
    await expect(
      pipe.transform(
        {
          ...bodyWithMenuFile(null),
          menu: {
            sections: [
              {
                title: 'Coffee',
                items: [{ name: 'Bica', price: '1', priceGlass: '1' }],
              },
            ],
            link: '',
          },
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a direct item carrying a bottle price, with a 400', async () => {
    await expect(
      pipe.transform(
        {
          ...bodyWithMenuFile(null),
          menu: {
            sections: [
              {
                title: 'Coffee',
                items: [{ name: 'Bica', price: '1', priceBottle: '1' }],
              },
            ],
            link: '',
          },
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown field on a sub-section item, with a 400', async () => {
    await expect(
      pipe.transform(
        {
          ...bodyWithMenuFile(null),
          menu: {
            sections: [
              {
                title: 'Wines',
                items: [],
                subsections: [
                  {
                    title: 'Red',
                    items: [{ name: 'Douro', priceMagnum: '90' }],
                  },
                ],
              },
            ],
            link: '',
          },
        },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects the same file with contentType added, with a 400', async () => {
    await expect(
      pipe.transform(
        bodyWithMenuFile({
          url: MENU_KEY,
          contentType: 'application/pdf',
          fileName: 'Menu.pdf',
        }),
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
