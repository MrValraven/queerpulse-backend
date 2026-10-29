import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateStudioPurchaseDto } from './create-studio-purchase.dto';
import { DeclineStudioPurchaseDto } from './decline-studio-purchase.dto';
import { ListMyStudioPurchasesQuery } from './list-my-studio-purchases.query';
import { ReplaceStudioPaymentMethodsDto } from './replace-studio-payment-methods.dto';
import { UpdateStudioPurchaseWallDto } from './update-studio-purchase-wall.dto';
import { UpdateStudioReleaseDto } from './update-studio-release.dto';
import { UpdateStudioTrackDto } from './update-studio-track.dto';

const RELEASE_ID = '3f0f6c0e-5d5b-4f0e-9a52-6c1f2f0b7a11';
const PERSONA_ID = '8a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';

const failingFields = async (
  dtoClass: new () => object,
  body: Record<string, unknown>,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

const VALID_PURCHASE = {
  releaseId: RELEASE_ID,
  amountCents: 800,
  isOnWall: true,
  shownAsSubprofileId: PERSONA_ID,
  referenceCode: 'QP7K3F',
  referenceToken: 'token',
};

describe('Studio purchase request DTOs', () => {
  it('takes a fixed or name-your-price price up to 50000 cents and null to take an item off sale', async () => {
    for (const dtoClass of [UpdateStudioReleaseDto, UpdateStudioTrackDto]) {
      expect(await failingFields(dtoClass, {})).toEqual([]);
      expect(await failingFields(dtoClass, { price: null })).toEqual([]);
      expect(
        await failingFields(dtoClass, {
          price: { mode: 'fixed', amountCents: 50000 },
        }),
      ).toEqual([]);
      expect(
        await failingFields(dtoClass, {
          price: { mode: 'name_your_price', amountCents: 0 },
        }),
      ).toEqual([]);
      expect(
        await failingFields(dtoClass, {
          price: { mode: 'fixed', amountCents: 50001 },
        }),
      ).toEqual(['price']);
      expect(
        await failingFields(dtoClass, {
          price: { mode: 'not_for_sale', amountCents: 500 },
        }),
      ).toEqual(['price']);
    }
  });

  it('refuses a negative or fractional price amount', async () => {
    expect(
      await failingFields(UpdateStudioReleaseDto, {
        price: { mode: 'fixed', amountCents: -1 },
      }),
    ).toEqual(['price']);
    expect(
      await failingFields(UpdateStudioTrackDto, {
        price: { mode: 'fixed', amountCents: 199.5 },
      }),
    ).toEqual(['price']);
  });

  it('takes up to any number of methods in the body and leaves the limit of 8 to the service', async () => {
    const methods = Array.from({ length: 9 }, () => ({
      kind: 'link',
      value: 'https://example.org/pay',
    }));
    expect(
      await failingFields(ReplaceStudioPaymentMethodsDto, { methods }),
    ).toEqual([]);
    expect(
      await failingFields(ReplaceStudioPaymentMethodsDto, { methods: [] }),
    ).toEqual([]);
    expect(await failingFields(ReplaceStudioPaymentMethodsDto, {})).toEqual([
      'methods',
    ]);
  });

  it('refuses an unknown kind and a value over 500 characters', async () => {
    expect(
      await failingFields(ReplaceStudioPaymentMethodsDto, {
        methods: [{ kind: 'paypal', value: 'x' }],
      }),
    ).toEqual(['methods']);
    expect(
      await failingFields(ReplaceStudioPaymentMethodsDto, {
        methods: [{ kind: 'link', value: 'x'.repeat(501) }],
      }),
    ).toEqual(['methods']);
    expect(
      await failingFields(ReplaceStudioPaymentMethodsDto, {
        methods: [
          { kind: 'iban', value: 'x'.repeat(500), label: null, note: null },
        ],
      }),
    ).toEqual([]);
  });

  it('takes a purchase with one item, an amount, the wall flag and a nullable identity key', async () => {
    expect(
      await failingFields(CreateStudioPurchaseDto, VALID_PURCHASE),
    ).toEqual([]);
    expect(
      await failingFields(CreateStudioPurchaseDto, {
        ...VALID_PURCHASE,
        releaseId: undefined,
        trackId: RELEASE_ID,
        shownAsSubprofileId: null,
        payerName: null,
      }),
    ).toEqual([]);
  });

  it('refuses a purchase without the identity key, an amount over 50000 and a payer name over 60', async () => {
    const { shownAsSubprofileId: _omitted, ...withoutIdentityKey } =
      VALID_PURCHASE;
    expect(
      await failingFields(CreateStudioPurchaseDto, withoutIdentityKey),
    ).toEqual(['shownAsSubprofileId']);
    expect(
      await failingFields(CreateStudioPurchaseDto, {
        ...VALID_PURCHASE,
        amountCents: 50001,
      }),
    ).toEqual(['amountCents']);
    expect(
      await failingFields(CreateStudioPurchaseDto, {
        ...VALID_PURCHASE,
        payerName: 'n'.repeat(61),
      }),
    ).toEqual(['payerName']);
  });

  it('takes a reference code from the alphabet and a token up to 200 characters', async () => {
    expect(
      await failingFields(CreateStudioPurchaseDto, VALID_PURCHASE),
    ).toEqual([]);
    for (const referenceCode of ['QP0K3F', 'qp7k3f', 'QP7K3']) {
      expect(
        await failingFields(CreateStudioPurchaseDto, {
          ...VALID_PURCHASE,
          referenceCode,
        }),
      ).toEqual(['referenceCode']);
    }
    const { referenceToken: _omitted, ...withoutToken } = VALID_PURCHASE;
    expect(await failingFields(CreateStudioPurchaseDto, withoutToken)).toEqual([
      'referenceToken',
    ]);
    expect(
      await failingFields(CreateStudioPurchaseDto, {
        ...VALID_PURCHASE,
        referenceToken: 't'.repeat(201),
      }),
    ).toEqual(['referenceToken']);
    expect(
      await failingFields(CreateStudioPurchaseDto, {
        ...VALID_PURCHASE,
        referenceToken: 't'.repeat(200),
      }),
    ).toEqual([]);
  });

  it('takes the wall flag with an identity key that is a uuid or null', async () => {
    expect(
      await failingFields(UpdateStudioPurchaseWallDto, {
        isOnWall: false,
        shownAsSubprofileId: null,
      }),
    ).toEqual([]);
    expect(
      await failingFields(UpdateStudioPurchaseWallDto, {
        isOnWall: true,
        shownAsSubprofileId: PERSONA_ID,
      }),
    ).toEqual([]);
    expect(
      await failingFields(UpdateStudioPurchaseWallDto, { isOnWall: true }),
    ).toEqual(['shownAsSubprofileId']);
    expect(
      await failingFields(UpdateStudioPurchaseWallDto, {
        isOnWall: true,
        shownAsSubprofileId: 'night-bus',
      }),
    ).toEqual(['shownAsSubprofileId']);
  });

  it('trims the payer name and the decline note', () => {
    expect(
      plainToInstance(CreateStudioPurchaseDto, {
        ...VALID_PURCHASE,
        payerName: '  Sam R.  ',
      }).payerName,
    ).toBe('Sam R.');
    expect(
      plainToInstance(DeclineStudioPurchaseDto, {
        reason: 'other',
        note: '  Nothing arrived yet  ',
      }).note,
    ).toBe('Nothing arrived yet');
  });

  it('takes the three decline reasons only', async () => {
    for (const reason of ['payment_not_found', 'amount_different', 'other']) {
      expect(await failingFields(DeclineStudioPurchaseDto, { reason })).toEqual(
        [],
      );
    }
    expect(
      await failingFields(DeclineStudioPurchaseDto, { reason: 'fraud' }),
    ).toEqual(['reason']);
    expect(await failingFields(DeclineStudioPurchaseDto, {})).toEqual([
      'reason',
    ]);
    expect(
      await failingFields(DeclineStudioPurchaseDto, {
        reason: 'other',
        note: 'n'.repeat(201),
      }),
    ).toEqual(['note']);
  });

  it('lists every status or confirmed only', async () => {
    expect(await failingFields(ListMyStudioPurchasesQuery, {})).toEqual([]);
    expect(
      await failingFields(ListMyStudioPurchasesQuery, {
        status: 'confirmed',
        cursor: 'abc',
      }),
    ).toEqual([]);
    expect(
      await failingFields(ListMyStudioPurchasesQuery, { status: 'pending' }),
    ).toEqual(['status']);
  });
});
