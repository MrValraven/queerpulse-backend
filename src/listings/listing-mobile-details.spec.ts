import { NEIGHBOURHOODS } from '../profiles/neighbourhoods';
import {
  LISBON_PARISH_NAMES,
  NEARBY_MUNICIPALITIES,
  emptyListingMobileDetails,
  findUnknownMobileAreaNames,
  hasListingMeetingPoint,
  isMobileWithoutMeetingPoint,
  listingKindOf,
  normalizeListingMobileDetails,
  toListingMobileDetailsView,
} from './listing-mobile-details';

describe('mobile listing vocabularies', () => {
  it('lists the 24 Lisbon parishes, each once', () => {
    expect(LISBON_PARISH_NAMES).toHaveLength(24);
    expect(new Set(LISBON_PARISH_NAMES).size).toBe(24);
  });

  it('spells every parish the way the shared neighbourhood list does', () => {
    const neighbourhoodNames = new Set<string>(NEIGHBOURHOODS);
    for (const parishName of LISBON_PARISH_NAMES) {
      expect(neighbourhoodNames.has(parishName)).toBe(true);
    }
  });

  it('stores every name precomposed (NFC)', () => {
    for (const name of [...LISBON_PARISH_NAMES, ...NEARBY_MUNICIPALITIES]) {
      expect(name).toBe(name.normalize('NFC'));
    }
  });

  it('lists the eight nearby municipalities in the contract order', () => {
    expect([...NEARBY_MUNICIPALITIES]).toEqual([
      'Almada',
      'Amadora',
      'Cascais',
      'Loures',
      'Odivelas',
      'Oeiras',
      'Seixal',
      'Sintra',
    ]);
  });
});

describe('emptyListingMobileDetails', () => {
  it('is the contract default', () => {
    expect(emptyListingMobileDetails()).toEqual({
      allOfCity: true,
      parishes: [],
      alsoTravelsTo: [],
      byAppointment: false,
    });
  });

  it('hands every caller its own arrays', () => {
    const first = emptyListingMobileDetails();
    first.parishes.push('Arroios');
    expect(emptyListingMobileDetails().parishes).toEqual([]);
  });
});

describe('normalizeListingMobileDetails', () => {
  it('reads a row from before the column held anything as the default', () => {
    expect(normalizeListingMobileDetails({})).toEqual(
      emptyListingMobileDetails(),
    );
    expect(normalizeListingMobileDetails(null)).toEqual(
      emptyListingMobileDetails(),
    );
    expect(normalizeListingMobileDetails('garbage')).toEqual(
      emptyListingMobileDetails(),
    );
  });

  it('empties the parishes of a listing that works across all of Lisbon', () => {
    expect(
      normalizeListingMobileDetails({
        allOfCity: true,
        parishes: ['Arroios'],
      }).parishes,
    ).toEqual([]);
  });

  it('keeps the chosen parishes once each, in list order', () => {
    expect(
      normalizeListingMobileDetails({
        allOfCity: false,
        parishes: ['Estrela', 'Arroios', 'Penha de França', 'Arroios'],
      }).parishes,
    ).toEqual(['Arroios', 'Estrela', 'Penha de França']);
  });

  it('matches a decomposed or padded name to its precomposed spelling', () => {
    const decomposedBelem = 'Belém'.normalize('NFD');
    expect(
      normalizeListingMobileDetails({
        allOfCity: false,
        parishes: [decomposedBelem, '  Ajuda '],
      }).parishes,
    ).toEqual(['Ajuda', 'Belém']);
  });

  it('drops names neither vocabulary knows', () => {
    const details = normalizeListingMobileDetails({
      allOfCity: false,
      parishes: ['Arroios', 'Anjos'],
      alsoTravelsTo: ['Oeiras', 'Porto', 7],
    });
    expect(details.parishes).toEqual(['Arroios']);
    expect(details.alsoTravelsTo).toEqual(['Oeiras']);
  });

  it('reads anything but true as no appointment rule and anything but false as all of Lisbon', () => {
    const details = normalizeListingMobileDetails({
      allOfCity: 'no',
      byAppointment: 'yes',
    });
    expect(details.allOfCity).toBe(true);
    expect(details.byAppointment).toBe(false);
  });

  it('is idempotent', () => {
    const once = normalizeListingMobileDetails({
      allOfCity: false,
      parishes: ['Estrela', 'Arroios'],
      alsoTravelsTo: ['Oeiras', 'Almada'],
      byAppointment: true,
    });
    expect(normalizeListingMobileDetails(once)).toEqual(once);
  });
});

describe('findUnknownMobileAreaNames', () => {
  it('names every parish and municipality outside the vocabularies', () => {
    expect(
      findUnknownMobileAreaNames({
        parishes: ['Arroios', 'Anjos'],
        alsoTravelsTo: ['Oeiras', 'Porto'],
      }),
    ).toEqual({ parishes: ['Anjos'], municipalities: ['Porto'] });
  });

  it('finds nothing in a decomposed spelling of a known name', () => {
    expect(
      findUnknownMobileAreaNames({
        parishes: ['São Vicente'.normalize('NFD')],
      }),
    ).toEqual({ parishes: [], municipalities: [] });
  });

  it('finds nothing in a missing or malformed value', () => {
    expect(findUnknownMobileAreaNames(undefined)).toEqual({
      parishes: [],
      municipalities: [],
    });
    expect(findUnknownMobileAreaNames({ parishes: 'Arroios' })).toEqual({
      parishes: [],
      municipalities: [],
    });
  });
});

describe('listingKindOf', () => {
  it('reads the three kinds', () => {
    expect(listingKindOf({ online: false, mobile: false })).toBe('place');
    expect(listingKindOf({ online: true, mobile: false })).toBe('online');
    expect(listingKindOf({ online: false, mobile: true })).toBe('mobile');
  });

  it('reads a row missing both flags as a place', () => {
    expect(listingKindOf({})).toBe('place');
    expect(listingKindOf({ online: null, mobile: null })).toBe('place');
  });

  it('lets online win when a row somehow carries both flags', () => {
    expect(listingKindOf({ online: true, mobile: true })).toBe('online');
  });
});

describe('meeting points', () => {
  const mobileAt = (latitude: number | null, longitude: number | null) => ({
    online: false,
    mobile: true,
    latitude,
    longitude,
  });

  it('needs a mobile listing with both coordinates', () => {
    expect(hasListingMeetingPoint(mobileAt(38.711, -9.133))).toBe(true);
    expect(hasListingMeetingPoint(mobileAt(38.711, null))).toBe(false);
    expect(hasListingMeetingPoint(mobileAt(null, null))).toBe(false);
  });

  it('never reads a place pin as a meeting point', () => {
    expect(
      hasListingMeetingPoint({
        online: false,
        mobile: false,
        latitude: 38.711,
        longitude: -9.133,
      }),
    ).toBe(false);
  });

  it('flags a mobile listing with no meeting point', () => {
    expect(isMobileWithoutMeetingPoint(mobileAt(null, null))).toBe(true);
    expect(isMobileWithoutMeetingPoint(mobileAt(38.711, -9.133))).toBe(false);
    expect(
      isMobileWithoutMeetingPoint({
        online: false,
        mobile: false,
        latitude: null,
        longitude: null,
      }),
    ).toBe(false);
  });
});

describe('toListingMobileDetailsView', () => {
  it('normalises the stored details of a mobile listing', () => {
    expect(
      toListingMobileDetailsView({
        online: false,
        mobile: true,
        mobileDetails: { allOfCity: false, parishes: ['Estrela', 'Arroios'] },
      }),
    ).toEqual({
      allOfCity: false,
      parishes: ['Arroios', 'Estrela'],
      alsoTravelsTo: [],
      byAppointment: false,
    });
  });

  it('answers the default for every other kind, whatever the column holds', () => {
    expect(
      toListingMobileDetailsView({
        online: false,
        mobile: false,
        mobileDetails: { allOfCity: false, parishes: ['Arroios'] },
      }),
    ).toEqual(emptyListingMobileDetails());
  });
});
