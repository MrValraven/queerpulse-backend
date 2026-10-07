import { BadRequestException } from '@nestjs/common';
import type { Listing } from './entities/listing.entity';
import { emptyAccessibilityAnswers } from './listing-accessibility';
import {
  ListingOnlineDetails,
  emptyListingOnlineDetails,
} from './listing-online-details';
import {
  ADULT_TERMS_REQUIRED_CODE,
  OnlineListingFields,
  OnlineListingRuleOptions,
  healStoredListingColumns,
  pickOnlineListingFields,
  resolveOnlineListingCity,
  resolveOnlineListingFields,
} from './listing-online-rules';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const STORED_STAMP = '2026-10-01T09:00:00.000Z';
const CLIENT_STAMP = '2020-01-01T00:00:00.000Z';

const placeFields = (
  overrides: Partial<OnlineListingFields> = {},
): OnlineListingFields => ({
  online: false,
  hasOnlineShop: false,
  cats: ['food'],
  pricingMode: 'services',
  onlineDetails: emptyListingOnlineDetails(),
  shopItems: [],
  hood: 'Arroios',
  address: 'Rua X 1',
  geocoded: true,
  latitude: 38.72,
  longitude: -9.13,
  ...overrides,
});

const ruleOptions = (
  overrides: Partial<OnlineListingRuleOptions> = {},
): OnlineListingRuleOptions => ({
  isAdultTermsAcceptedNow: false,
  storedAdultTermsAcceptedAt: null,
  shouldCheckCategories: true,
  shouldRequireMainLink: true,
  now: NOW,
  ...overrides,
});

const detailsWithMainLink = (
  overrides: Partial<ListingOnlineDetails> = {},
): ListingOnlineDetails => ({
  ...emptyListingOnlineDetails(),
  mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
  ...overrides,
});

const onlineFields = (
  overrides: Partial<OnlineListingFields> = {},
): OnlineListingFields =>
  placeFields({
    online: true,
    cats: ['handmade'],
    onlineDetails: detailsWithMainLink(),
    ...overrides,
  });

/** The exception `action` throws, or `undefined` when it throws nothing. */
function thrownBy(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('resolveOnlineListingFields', () => {
  describe('rule 1: an online-only listing', () => {
    it('carries no location and no online shop flag', () => {
      const resolved = resolveOnlineListingFields(
        onlineFields({ hasOnlineShop: true }),
        ruleOptions(),
      );

      expect(resolved).toMatchObject({
        online: true,
        hasOnlineShop: false,
        hood: '',
        address: '',
        geocoded: false,
        latitude: null,
        longitude: null,
      });
    });
  });

  describe('rule 2: a listing that does not sell online', () => {
    it('empties the online details and the shop items', () => {
      const resolved = resolveOnlineListingFields(
        placeFields({
          onlineDetails: detailsWithMainLink({ replyNote: 'Stale note' }),
          shopItems: [
            { id: 'item-1', name: 'Mug', price: '', link: '', photo: null },
          ],
        }),
        ruleOptions(),
      );

      expect(resolved.onlineDetails).toEqual(emptyListingOnlineDetails());
      expect(resolved.shopItems).toEqual([]);
      expect(resolved.hood).toBe('Arroios');
    });

    it('moves a shop pricing mode back to the default for its categories', () => {
      expect(
        resolveOnlineListingFields(
          placeFields({ pricingMode: 'shop', cats: ['food'] }),
          ruleOptions(),
        ).pricingMode,
      ).toBe('menu');
      expect(
        resolveOnlineListingFields(
          placeFields({ pricingMode: 'shop', cats: ['design'] }),
          ruleOptions(),
        ).pricingMode,
      ).toBe('services');
    });

    it('keeps the record of an 18+ acceptance', () => {
      expect(
        resolveOnlineListingFields(
          placeFields(),
          ruleOptions({ storedAdultTermsAcceptedAt: STORED_STAMP }),
        ).onlineDetails.adultTermsAcceptedAt,
      ).toBe(STORED_STAMP);
    });
  });

  describe('rule 3: a place that also sells online', () => {
    it('leaves pick-up out, since the place has an address', () => {
      const resolved = resolveOnlineListingFields(
        placeFields({
          hasOnlineShop: true,
          onlineDetails: detailsWithMainLink({
            fulfilment: ['shipsEu', 'pickupLisbon'],
            pickupNote: 'At the counter',
          }),
          pricingMode: 'shop',
        }),
        ruleOptions(),
      );

      expect(resolved.hasOnlineShop).toBe(true);
      expect(resolved.onlineDetails.fulfilment).toEqual(['shipsEu']);
      expect(resolved.onlineDetails.pickupNote).toBe('');
      expect(resolved.pricingMode).toBe('shop');
      expect(resolved.address).toBe('Rua X 1');
    });
  });

  describe('rule 4: the main link', () => {
    it('is required once a listing sells online', () => {
      for (const fields of [
        onlineFields({ onlineDetails: emptyListingOnlineDetails() }),
        placeFields({ hasOnlineShop: true }),
      ]) {
        expect(() => resolveOnlineListingFields(fields, ruleOptions())).toThrow(
          'onlineDetails.mainLink is required',
        );
      }
    });

    it('is not asked of a place that does not sell online', () => {
      expect(() =>
        resolveOnlineListingFields(placeFields(), ruleOptions()),
      ).not.toThrow();
    });

    it('skips the main link check when the write left the online fields alone', () => {
      const resolved = resolveOnlineListingFields(
        onlineFields({ onlineDetails: emptyListingOnlineDetails() }),
        ruleOptions({ shouldRequireMainLink: false }),
      );

      expect(resolved.onlineDetails.mainLink).toBeNull();
      expect(resolved.hood).toBe('');
    });
  });

  describe('categories per kind of listing', () => {
    it('refuses a place category on an online listing, naming it', () => {
      expect(() =>
        resolveOnlineListingFields(
          onlineFields({ cats: ['nightlife'] }),
          ruleOptions(),
        ),
      ).toThrow('Category "nightlife" is not offered to online listings');
    });

    it('refuses an online category on a place, naming it', () => {
      expect(() =>
        resolveOnlineListingFields(
          placeFields({ cats: ['apparel'] }),
          ruleOptions(),
        ),
      ).toThrow('Category "apparel" is not offered to place listings');
    });

    it('lets a legacy category through when the write did not touch categories', () => {
      expect(() =>
        resolveOnlineListingFields(
          placeFields({ cats: ['café'] }),
          ruleOptions({ shouldCheckCategories: false }),
        ),
      ).not.toThrow();
    });

    it('refuses the 18+ category on a place even when categories were not touched', () => {
      expect(() =>
        resolveOnlineListingFields(
          placeFields({ cats: ['intimacy'] }),
          ruleOptions({ shouldCheckCategories: false }),
        ),
      ).toThrow('Category "intimacy" is not offered to place listings');
    });
  });

  describe('rule 6: the 18+ terms', () => {
    it('answers adult_terms_required when the terms were never accepted', () => {
      const failure = thrownBy(() =>
        resolveOnlineListingFields(
          onlineFields({ cats: ['intimacy'] }),
          ruleOptions(),
        ),
      );

      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: ADULT_TERMS_REQUIRED_CODE,
      });
    });

    it('stamps the first acceptance from the server clock', () => {
      expect(
        resolveOnlineListingFields(
          onlineFields({ cats: ['intimacy'] }),
          ruleOptions({ isAdultTermsAcceptedNow: true }),
        ).onlineDetails.adultTermsAcceptedAt,
      ).toBe(NOW.toISOString());
    });

    it('needs no second acceptance and keeps the first stamp', () => {
      for (const isAdultTermsAcceptedNow of [false, true]) {
        expect(
          resolveOnlineListingFields(
            onlineFields({ cats: ['intimacy'] }),
            ruleOptions({
              isAdultTermsAcceptedNow,
              storedAdultTermsAcceptedAt: STORED_STAMP,
            }),
          ).onlineDetails.adultTermsAcceptedAt,
        ).toBe(STORED_STAMP);
      }
    });

    describe('a stamp sent by a client is ignored', () => {
      const clientStampedDetails = () =>
        detailsWithMainLink({ adultTermsAcceptedAt: CLIENT_STAMP });

      it('still asks for the terms when only the client stamp is present', () => {
        const failure = thrownBy(() =>
          resolveOnlineListingFields(
            onlineFields({
              cats: ['intimacy'],
              onlineDetails: clientStampedDetails(),
            }),
            ruleOptions(),
          ),
        );

        expect(failure).toBeInstanceOf(BadRequestException);
        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: ADULT_TERMS_REQUIRED_CODE,
        });
      });

      it('stamps a first acceptance from the server clock over the client stamp', () => {
        expect(
          resolveOnlineListingFields(
            onlineFields({
              cats: ['intimacy'],
              onlineDetails: clientStampedDetails(),
            }),
            ruleOptions({ isAdultTermsAcceptedNow: true }),
          ).onlineDetails.adultTermsAcceptedAt,
        ).toBe(NOW.toISOString());
      });

      it('keeps the stored stamp over the client stamp', () => {
        expect(
          resolveOnlineListingFields(
            onlineFields({
              cats: ['intimacy'],
              onlineDetails: clientStampedDetails(),
            }),
            ruleOptions({ storedAdultTermsAcceptedAt: STORED_STAMP }),
          ).onlineDetails.adultTermsAcceptedAt,
        ).toBe(STORED_STAMP);
      });

      it('stores no stamp for a listing outside the 18+ category', () => {
        for (const fields of [
          onlineFields({ onlineDetails: clientStampedDetails() }),
          placeFields({ onlineDetails: clientStampedDetails() }),
          placeFields({
            hasOnlineShop: true,
            onlineDetails: clientStampedDetails(),
          }),
        ]) {
          expect(
            resolveOnlineListingFields(fields, ruleOptions()).onlineDetails
              .adultTermsAcceptedAt,
          ).toBeNull();
        }
      });
    });
  });
});

describe('pickOnlineListingFields', () => {
  it('copies exactly the fields the rules read and write', () => {
    const fields = onlineFields();
    expect(
      pickOnlineListingFields({
        ...fields,
        name: 'Fio Rosa',
      } as unknown as OnlineListingFields),
    ).toEqual(fields);
  });
});

describe('healStoredListingColumns', () => {
  it('reads an old row as complete values, ten accessibility answers included', () => {
    const listing = {
      onlineDetails: {},
      shopItems: undefined,
      accessibilityAnswers: emptyAccessibilityAnswers(),
    } as unknown as Pick<
      Listing,
      'onlineDetails' | 'shopItems' | 'accessibilityAnswers'
    >;

    healStoredListingColumns(listing);

    expect(listing.onlineDetails).toEqual(emptyListingOnlineDetails());
    expect(listing.shopItems).toEqual([]);
    expect(Object.keys(listing.accessibilityAnswers)).toHaveLength(10);
  });
});

describe('resolveOnlineListingCity', () => {
  it('keeps the city as typed, trimmed, and reads a missing one as empty', () => {
    expect(resolveOnlineListingCity('  Porto ')).toBe('Porto');
    expect(resolveOnlineListingCity(undefined)).toBe('');
    expect(resolveOnlineListingCity(null)).toBe('');
  });
});
