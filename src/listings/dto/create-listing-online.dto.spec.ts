import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { AdminCreateListingDto } from './admin-create-listing.dto';
import { AdminUpdateListingDto } from './admin-update-listing.dto';
import { CreateListingDto } from './create-listing.dto';
import {
  ListAdultDirectoryQuery,
  ListListingDirectoryQuery,
} from './list-directory.query';
import { UpdateListingDto } from './update-listing.dto';

async function errorsOn(property: string, body: Record<string, unknown>) {
  const dto = plainToInstance(CreateListingDto, body);
  const errors = await validate(dto, { skipMissingProperties: true });
  return errors.filter((error) => error.property === property);
}

describe('CreateListingDto online fields', () => {
  it('accepts online and place categories alike, leaving the per-kind check to the service', async () => {
    expect(await errorsOn('cats', { cats: ['apparel', 'food'] })).toHaveLength(
      0,
    );
    expect(await errorsOn('cats', { cats: ['nightlife'] })).toHaveLength(0);
  });

  it('refuses a category neither vocabulary knows', async () => {
    expect(await errorsOn('cats', { cats: ['bakery'] })).toHaveLength(1);
  });

  it('accepts the shop pricing mode', async () => {
    expect(await errorsOn('pricingMode', { pricingMode: 'shop' })).toHaveLength(
      0,
    );
    expect(
      await errorsOn('pricingMode', { pricingMode: 'catalogue' }),
    ).toHaveLength(1);
  });

  it('accepts an online accessibility answer on a listing', async () => {
    expect(
      await errorsOn('accessibility', {
        accessibility: { answers: { 'image-descriptions': 'yes' } },
      }),
    ).toHaveLength(0);
  });

  it('validates onlineDetails field by field', async () => {
    expect(
      await errorsOn('onlineDetails', {
        onlineDetails: { mainLink: { url: 'fiorosa.pt', kind: 'shopfront' } },
      }),
    ).toHaveLength(1);
  });

  it('refuses a seventh shop item', async () => {
    const shopItems = Array.from({ length: 7 }, (_unused, index) => ({
      id: `item-${index}`,
      name: `Item ${index}`,
    }));
    expect(await errorsOn('shopItems', { shopItems })).toHaveLength(1);
  });

  it('refuses two shop items with the same id', async () => {
    expect(
      await errorsOn('shopItems', {
        shopItems: [
          { id: 'item-1', name: 'Zine' },
          { id: 'item-1', name: 'Mug' },
        ],
      }),
    ).toHaveLength(1);
    expect(
      await errorsOn('shopItems', {
        shopItems: [
          { id: 'item-1', name: 'Zine' },
          { id: 'item-2', name: 'Mug' },
        ],
      }),
    ).toHaveLength(0);
  });

  it('refuses an adultTermsAccepted that is no boolean', async () => {
    expect(
      await errorsOn('adultTermsAccepted', { adultTermsAccepted: 'yes' }),
    ).toHaveLength(1);
  });

  it('carries the online fields onto the update body, the 18+ acceptance included', async () => {
    const updateErrors = await validate(
      plainToInstance(UpdateListingDto, {
        hasOnlineShop: 'yes',
        adultTermsAccepted: 'yes',
      }),
      { skipMissingProperties: true },
    );
    expect(updateErrors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['hasOnlineShop', 'adultTermsAccepted']),
    );
  });
});

// Staff cannot accept the 18+ terms on a business's behalf, so both admin
// bodies omit the field and the real pipe refuses it, the way it refuses
// `affirmingBaselineAccepted` there.
describe('the admin bodies and the 18+ acceptance', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

  async function refusalOf(
    metatype: ArgumentMetadata['metatype'],
    body: Record<string, unknown>,
  ): Promise<string> {
    const failure: unknown = await pipe
      .transform(body, { type: 'body', metatype })
      .catch((error: unknown) => error);
    return failure instanceof BadRequestException
      ? JSON.stringify(failure.getResponse())
      : '';
  }

  it('refuses adultTermsAccepted on the staff create body', async () => {
    expect(
      await refusalOf(AdminCreateListingDto, { adultTermsAccepted: true }),
    ).toContain('property adultTermsAccepted should not exist');
  });

  it('refuses adultTermsAccepted on the staff update body and keeps the other online fields', async () => {
    expect(
      await refusalOf(AdminUpdateListingDto, { adultTermsAccepted: true }),
    ).toContain('property adultTermsAccepted should not exist');
    await expect(
      pipe.transform(
        {
          hasOnlineShop: true,
          onlineDetails: { mainLink: { url: 'casa.pt', kind: 'shop' } },
        },
        { type: 'body', metatype: AdminUpdateListingDto },
      ),
    ).resolves.toBeInstanceOf(AdminUpdateListingDto);
  });
});

// The update body's `PartialType` skips validation on `null`, so a PATCH
// carrying `online: null` reached the service as a value and turned the
// listing into a place. The base field now reads `null` as an absent key.
describe('a null online flag on the update body', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

  it('reads online: null and hasOnlineShop: null as keys the body left out', async () => {
    const updateBody: unknown = await pipe.transform(
      { online: null, hasOnlineShop: null, blurb: 'Hand-dyed yarn.' },
      { type: 'body', metatype: UpdateListingDto },
    );

    expect(updateBody).toBeInstanceOf(UpdateListingDto);
    expect((updateBody as UpdateListingDto).online).toBeUndefined();
    expect((updateBody as UpdateListingDto).hasOnlineShop).toBeUndefined();
    expect((updateBody as UpdateListingDto).blurb).toBe('Hand-dyed yarn.');
  });

  it('reads online: null as absent on the staff update body too', async () => {
    const updateBody: unknown = await pipe.transform(
      { online: null },
      { type: 'body', metatype: AdminUpdateListingDto },
    );

    expect((updateBody as AdminUpdateListingDto).online).toBeUndefined();
  });

  it('still refuses an online flag that is no boolean', async () => {
    await expect(
      pipe.transform(
        { online: 'yes' },
        { type: 'body', metatype: UpdateListingDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('an online listing through the real ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: CreateListingDto,
  };

  const onlineSuggestion = (shopItems: unknown[] = []) => ({
    path: 'suggest',
    name: 'Fio Rosa',
    cats: ['handmade'],
    online: true,
    city: 'Porto',
    blurb: 'Hand-dyed yarn.',
    whatItIs: [{ id: 'w1', text: 'Yarn, dyed by hand.' }],
    onlineDetails: {
      mainLink: { url: 'fiorosa.pt', kind: 'shop' },
      adultTermsAcceptedAt: '2026-10-07T10:00:00.000Z',
    },
    shopItems,
  });

  it('passes a body that echoes the owner wire, acceptance stamp included', async () => {
    await expect(
      pipe.transform(onlineSuggestion(), metadata),
    ).resolves.toBeInstanceOf(CreateListingDto);
  });

  it('refuses a shop item photo carrying a crop, as it refuses one on a gallery photo', async () => {
    const failure: unknown = await pipe
      .transform(
        onlineSuggestion([
          {
            id: 'item-1',
            name: 'Skein',
            photo: {
              image: 'https://images.unsplash.com/photo-skein.jpg',
              alt: 'A skein of pink yarn',
              crop: { x: 0, y: 0, width: 1, height: 1, aspect: 'free' },
            },
          },
        ]),
        metadata,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect(
      JSON.stringify((failure as BadRequestException).getResponse()),
    ).toContain('property crop should not exist');
  });
});

describe('directory queries', () => {
  it('accepts online=true and refuses any other value', async () => {
    expect(
      await validate(
        plainToInstance(ListListingDirectoryQuery, { online: 'true' }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ListListingDirectoryQuery, { online: 'false' }),
      ),
    ).toHaveLength(1);
  });

  it('gives the 18+ list the category and search filters only', async () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const metadata: ArgumentMetadata = {
      type: 'query',
      metatype: ListAdultDirectoryQuery,
    };
    await expect(
      pipe.transform({ cat: 'intimacy', q: 'zine' }, metadata),
    ).resolves.toBeInstanceOf(ListAdultDirectoryQuery);
    await expect(
      pipe.transform({ page: '1' }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
