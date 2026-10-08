import { BadRequestException } from '@nestjs/common';
import type { Listing } from './entities/listing.entity';
import { emptyListingMobileDetails } from './listing-mobile-details';
import {
  MobileListingInput,
  ONLINE_AND_MOBILE_MESSAGE,
  PARISHES_REQUIRED_MESSAGE,
  assertSingleListingKind,
  healStoredMobileDetails,
  pickMobileListingFields,
  resolveMobileListingFields,
} from './listing-mobile-rules';

const placeInput = (
  overrides: Partial<MobileListingInput> = {},
): MobileListingInput => ({
  online: false,
  mobile: false,
  mobileDetails: emptyListingMobileDetails(),
  hood: 'Santa Maria Maior',
  address: 'Praça do Comércio',
  geocoded: true,
  latitude: 38.7075,
  longitude: -9.1364,
  ...overrides,
});

const mobileInput = (
  overrides: Partial<MobileListingInput> = {},
): MobileListingInput => placeInput({ mobile: true, ...overrides });

/** The exception `action` throws, or `undefined` when it throws nothing. */
function thrownBy(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('assertSingleListingKind', () => {
  it('refuses a listing that is online only and out and about at once', () => {
    const failure = thrownBy(() =>
      assertSingleListingKind({ online: true, mobile: true }),
    );
    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).message).toBe(
      ONLINE_AND_MOBILE_MESSAGE,
    );
  });

  it('passes every single kind and missing flags', () => {
    expect(() =>
      assertSingleListingKind({ online: true, mobile: false }),
    ).not.toThrow();
    expect(() =>
      assertSingleListingKind({ online: false, mobile: true }),
    ).not.toThrow();
    expect(() => assertSingleListingKind({})).not.toThrow();
  });
});

describe('resolveMobileListingFields', () => {
  describe('rule 1: one kind at a time', () => {
    it('refuses online and mobile together before any other rule', () => {
      const failure = thrownBy(() =>
        resolveMobileListingFields(
          mobileInput({
            online: true,
            mobileDetails: { allOfCity: false, parishes: ['Nowhere'] },
          }),
        ),
      );
      expect((failure as BadRequestException).message).toBe(
        ONLINE_AND_MOBILE_MESSAGE,
      );
    });
  });

  describe('rule 2: a listing that is not mobile', () => {
    it('resets the details to the default and leaves the location alone', () => {
      const resolved = resolveMobileListingFields(
        placeInput({
          mobileDetails: {
            allOfCity: false,
            parishes: ['Arroios'],
            byAppointment: true,
          },
        }),
      );
      expect(resolved).toEqual({
        online: false,
        mobile: false,
        mobileDetails: emptyListingMobileDetails(),
        hood: 'Santa Maria Maior',
        address: 'Praça do Comércio',
        geocoded: true,
        latitude: 38.7075,
        longitude: -9.1364,
      });
    });

    it('leaves the blank location of an online listing as the online rules left it', () => {
      const resolved = resolveMobileListingFields(
        placeInput({
          online: true,
          hood: '',
          address: '',
          geocoded: false,
          latitude: null,
          longitude: null,
        }),
      );
      expect(resolved.online).toBe(true);
      expect(resolved.mobile).toBe(false);
      expect(resolved.address).toBe('');
    });
  });

  describe('rule 3: all of Lisbon', () => {
    it('empties the parishes', () => {
      const resolved = resolveMobileListingFields(
        mobileInput({
          mobileDetails: { allOfCity: true, parishes: ['Arroios'] },
        }),
      );
      expect(resolved.mobileDetails.parishes).toEqual([]);
      expect(resolved.mobileDetails.allOfCity).toBe(true);
    });

    it('reads missing details as all of Lisbon', () => {
      const resolved = resolveMobileListingFields(
        mobileInput({ mobileDetails: undefined }),
      );
      expect(resolved.mobileDetails).toEqual(emptyListingMobileDetails());
    });
  });

  describe('rule 4: some parishes', () => {
    it('refuses "some parishes" with none picked', () => {
      const failure = thrownBy(() =>
        resolveMobileListingFields(
          mobileInput({ mobileDetails: { allOfCity: false, parishes: [] } }),
        ),
      );
      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).message).toBe(
        PARISHES_REQUIRED_MESSAGE,
      );
    });

    it('keeps the picked parishes once each, in list order', () => {
      const resolved = resolveMobileListingFields(
        mobileInput({
          mobileDetails: {
            allOfCity: false,
            parishes: ['Penha de França', 'Arroios', 'Estrela', 'Arroios'],
            alsoTravelsTo: ['Oeiras', 'Almada'],
          },
        }),
      );
      expect(resolved.mobileDetails).toEqual({
        allOfCity: false,
        parishes: ['Arroios', 'Estrela', 'Penha de França'],
        alsoTravelsTo: ['Almada', 'Oeiras'],
        byAppointment: false,
      });
    });
  });

  describe('rule 5: names outside the vocabularies', () => {
    it('refuses an unknown parish and names it', () => {
      const failure = thrownBy(() =>
        resolveMobileListingFields(
          mobileInput({
            mobileDetails: { allOfCity: false, parishes: ['Anjos'] },
          }),
        ),
      );
      expect((failure as BadRequestException).message).toBe(
        'mobileDetails.parishes holds a name outside the 24 Lisbon parishes: "Anjos".',
      );
    });

    it('refuses an unknown municipality and names it', () => {
      const failure = thrownBy(() =>
        resolveMobileListingFields(
          mobileInput({ mobileDetails: { alsoTravelsTo: ['Porto'] } }),
        ),
      );
      expect((failure as BadRequestException).message).toBe(
        'mobileDetails.alsoTravelsTo holds a name outside the nearby municipalities: "Porto".',
      );
    });

    it('refuses an unknown name on a listing that is not mobile too', () => {
      expect(
        thrownBy(() =>
          resolveMobileListingFields(
            placeInput({ mobileDetails: { alsoTravelsTo: ['Porto'] } }),
          ),
        ),
      ).toBeInstanceOf(BadRequestException);
    });

    it('takes a decomposed spelling of a known parish', () => {
      const resolved = resolveMobileListingFields(
        mobileInput({
          mobileDetails: {
            allOfCity: false,
            parishes: ['Belém'.normalize('NFD')],
          },
        }),
      );
      expect(resolved.mobileDetails.parishes).toEqual(['Belém']);
    });
  });

  describe('rule 7: the meeting point', () => {
    it('keeps the location of a mobile listing with both coordinates as its meeting point', () => {
      const resolved = resolveMobileListingFields(mobileInput());
      expect(resolved).toMatchObject({
        mobile: true,
        hood: 'Santa Maria Maior',
        address: 'Praça do Comércio',
        geocoded: true,
        latitude: 38.7075,
        longitude: -9.1364,
      });
    });

    it.each([
      ['no coordinates', { latitude: null, longitude: null }],
      ['only a latitude', { latitude: 38.7075, longitude: null }],
      ['only a longitude', { latitude: null, longitude: -9.1364 }],
    ])('stores no location for a mobile listing with %s', (_label, pin) => {
      const resolved = resolveMobileListingFields(mobileInput(pin));
      expect(resolved).toMatchObject({
        hood: '',
        address: '',
        geocoded: false,
        latitude: null,
        longitude: null,
      });
    });
  });

  it('keeps the by-appointment answer of a mobile listing', () => {
    const resolved = resolveMobileListingFields(
      mobileInput({ mobileDetails: { byAppointment: true } }),
    );
    expect(resolved.mobileDetails.byAppointment).toBe(true);
  });

  it('is idempotent on its own output', () => {
    const once = resolveMobileListingFields(
      mobileInput({
        latitude: null,
        longitude: null,
        mobileDetails: { allOfCity: false, parishes: ['Arroios'] },
      }),
    );
    expect(resolveMobileListingFields(once)).toEqual(once);
  });
});

describe('pickMobileListingFields', () => {
  it('copies exactly the fields the rules read and write', () => {
    const row = {
      ...placeInput(),
      mobileDetails: emptyListingMobileDetails(),
      name: 'Lisboa a Pé',
      cats: ['tours'],
    } as unknown as Listing;
    expect(Object.keys(pickMobileListingFields(row)).sort()).toEqual([
      'address',
      'geocoded',
      'hood',
      'latitude',
      'longitude',
      'mobile',
      'mobileDetails',
      'online',
    ]);
  });
});

describe('healStoredMobileDetails', () => {
  it('reads a stored "{}" on a mobile row as the full default', () => {
    const row = {
      mobile: true,
      mobileDetails: {},
    } as unknown as Pick<Listing, 'mobile' | 'mobileDetails'>;
    healStoredMobileDetails(row);
    expect(row.mobileDetails).toEqual(emptyListingMobileDetails());
  });

  it('gives a row that is not mobile the default whatever it held', () => {
    const row = {
      mobile: false,
      mobileDetails: { allOfCity: false, parishes: ['Arroios'] },
    } as unknown as Pick<Listing, 'mobile' | 'mobileDetails'>;
    healStoredMobileDetails(row);
    expect(row.mobileDetails).toEqual(emptyListingMobileDetails());
  });
});
