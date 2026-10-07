// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` both require every `src/migrations/*.ts` file, and
// requiring a spec there throws `describe is not defined` before any
// migration runs. Same convention as `work-taxonomy-migration.spec.ts`.
import {
  ONLINE_TO_PLACE_CATEGORY_AT_MIGRATION,
  PLACE_TO_ONLINE_CATEGORY_AT_MIGRATION,
  convertOnlineListingRowDown,
  convertOnlineListingRowUp,
} from './listing-online-details-migration';

const fioRosaRow = {
  cats: ['design', 'culture'],
  tags: ['Ships to Portugal', 'mb way', 'Made to order', 'Video sessions'],
  hoursNote: '  Orders packed Tuesdays and Fridays.  ',
  social: { website: 'fiorosa.pt', instagram: 'fiorosa' },
};

describe('online listing migration, up', () => {
  it('moves every tag that became a field, in canonical order, and empties those tags', () => {
    const converted = convertOnlineListingRowUp({
      ...fioRosaRow,
      tags: [
        'Ships worldwide',
        'Ships to Portugal',
        'PayPal',
        'MB WAY',
        'Phone sessions',
        'Video sessions',
        'Digital downloads',
        'Pick-up in Lisbon',
        'Ships across the EU',
        'Multibanco',
      ],
    });

    expect(converted.onlineDetails.fulfilment).toEqual([
      'shipsPortugal',
      'shipsEu',
      'shipsWorldwide',
      'digital',
      'pickupLisbon',
    ]);
    expect(converted.onlineDetails.payments).toEqual([
      'mbway',
      'multibanco',
      'paypal',
    ]);
    expect(converted.onlineDetails.sessionFormats).toEqual(['video', 'phone']);
    expect(converted.tags).toEqual([]);
  });

  it('matches moved tags whatever their case and keeps every other tag in order', () => {
    const converted = convertOnlineListingRowUp(fioRosaRow);

    expect(converted.tags).toEqual(['Made to order']);
    expect(converted.onlineDetails.payments).toEqual(['mbway']);
    expect(converted.onlineDetails.fulfilment).toEqual(['shipsPortugal']);
    expect(converted.onlineDetails.sessionFormats).toEqual(['video']);
  });

  it('moves the hours note into the reply note, trimmed, and clears it', () => {
    const converted = convertOnlineListingRowUp(fioRosaRow);

    expect(converted.onlineDetails.replyNote).toBe(
      'Orders packed Tuesdays and Fridays.',
    );
    expect(converted.hoursNote).toBe('');
  });

  it('cuts a long hours note to its first 140 characters', () => {
    const converted = convertOnlineListingRowUp({
      ...fioRosaRow,
      hoursNote: 'é'.repeat(200),
    });

    expect(Array.from(converted.onlineDetails.replyNote)).toHaveLength(140);
  });

  it('turns the website into a website main link, with https when it had no protocol', () => {
    expect(
      convertOnlineListingRowUp(fioRosaRow).onlineDetails.mainLink,
    ).toEqual({ url: 'https://fiorosa.pt', kind: 'website' });
    expect(
      convertOnlineListingRowUp({
        ...fioRosaRow,
        social: { website: 'http://old.example.pt' },
      }).onlineDetails.mainLink,
    ).toEqual({ url: 'http://old.example.pt', kind: 'website' });
  });

  it('leaves the main link empty for a missing, blank or non-web website', () => {
    for (const social of [
      null,
      {},
      { website: '   ' },
      { website: 'mailto:ola@fiorosa.pt' },
    ]) {
      expect(
        convertOnlineListingRowUp({ ...fioRosaRow, social }).onlineDetails
          .mainLink,
      ).toBeNull();
    }
  });

  it('maps place categories onto the online vocabulary and drops space and nightlife', () => {
    const categoriesAfter = (cats: string[]) =>
      convertOnlineListingRowUp({ ...fioRosaRow, cats }).cats;

    expect(categoriesAfter(['design', 'culture'])).toEqual([
      'handmade',
      'books-music',
    ]);
    expect(categoriesAfter(['health', 'food'])).toEqual(['therapy', 'food']);
    expect(categoriesAfter(['tech', 'grooming'])).toEqual([
      'digital',
      'body-care',
    ]);
    expect(categoriesAfter(['fitness'])).toEqual(['classes']);
    expect(categoriesAfter(['space', 'nightlife'])).toEqual([]);
  });

  it('clears the city the old write path forced, which the owner never stated', () => {
    expect(convertOnlineListingRowUp(fioRosaRow).city).toBe('');
  });

  it('clears the neighbourhood, the address and the map pin', () => {
    const converted = convertOnlineListingRowUp(fioRosaRow);

    expect(converted.hood).toBe('');
    expect(converted.address).toBe('');
    expect(converted.geocoded).toBe(false);
    expect(converted.latitude).toBeNull();
    expect(converted.longitude).toBeNull();
  });

  it('keeps a 300-character website as the main link, and leaves out a longer one', () => {
    const typedWebsite = `${'a'.repeat(297)}.pt`;

    expect(
      convertOnlineListingRowUp({
        ...fioRosaRow,
        social: { website: typedWebsite },
      }).onlineDetails.mainLink,
    ).toEqual({ url: `https://${typedWebsite}`, kind: 'website' });
    expect(
      convertOnlineListingRowUp({
        ...fioRosaRow,
        social: { website: `https://${typedWebsite}` },
      }).onlineDetails.mainLink,
    ).toEqual({ url: `https://${typedWebsite}`, kind: 'website' });
    expect(
      convertOnlineListingRowUp({
        ...fioRosaRow,
        social: { website: `a${typedWebsite}` },
      }).onlineDetails.mainLink,
    ).toBeNull();
  });

  it('leaves out a website holding whitespace or a backslash', () => {
    for (const website of [
      'etsy.com\n.evil.pt',
      'etsy.com\t.evil.pt',
      'etsy.com\\@evil.pt',
    ]) {
      expect(
        convertOnlineListingRowUp({ ...fioRosaRow, social: { website } })
          .onlineDetails.mainLink,
      ).toBeNull();
    }
  });

  it('skips a NULL tag element and still moves the others', () => {
    const converted = convertOnlineListingRowUp({
      ...fioRosaRow,
      tags: [null, 'MB WAY', 'Made to order'],
    });

    expect(converted.tags).toEqual(['Made to order']);
    expect(converted.onlineDetails.payments).toEqual(['mbway']);
  });

  it('writes every online_details key, so the row reads complete', () => {
    expect(
      convertOnlineListingRowUp({
        cats: null,
        tags: null,
        hoursNote: null,
        social: null,
      }),
    ).toEqual({
      cats: [],
      tags: [],
      hoursNote: '',
      city: '',
      hood: '',
      address: '',
      geocoded: false,
      latitude: null,
      longitude: null,
      onlineDetails: {
        mainLink: null,
        moreLinks: [],
        fulfilment: [],
        pickupNote: '',
        shipsFrom: '',
        isVatIncluded: false,
        payments: [],
        sessionFormats: [],
        registration: { body: '', number: '' },
        replyNote: '',
        adultTermsAcceptedAt: null,
      },
    });
  });
});

describe('online listing migration, down', () => {
  it('reverses the tag, hours note and category moves of an up', () => {
    const up = convertOnlineListingRowUp(fioRosaRow);
    const down = convertOnlineListingRowDown({
      cats: up.cats,
      tags: up.tags,
      hoursNote: up.hoursNote,
      onlineDetails: up.onlineDetails,
    });

    expect(down.cats).toEqual(['design', 'culture']);
    expect(down.tags).toEqual([
      'Made to order',
      'Ships to Portugal',
      'MB WAY',
      'Video sessions',
    ]);
    expect(down.hoursNote).toBe('Orders packed Tuesdays and Fridays.');
  });

  it('keeps food and drops online categories with no place match', () => {
    const categoriesAfter = (cats: string[]) =>
      convertOnlineListingRowDown({
        cats,
        tags: [],
        hoursNote: '',
        onlineDetails: {},
      }).cats;

    expect(categoriesAfter(['apparel', 'intimacy', 'food'])).toEqual(['food']);
    expect(categoriesAfter(['services', 'digital'])).toEqual(['tech']);
  });

  it('adds back no tag the row still carries', () => {
    expect(
      convertOnlineListingRowDown({
        cats: [],
        tags: ['MB WAY'],
        hoursNote: '',
        onlineDetails: { payments: ['mbway'] },
      }).tags,
    ).toEqual(['MB WAY']);
  });

  it('restores no tag for a value that never was one', () => {
    expect(
      convertOnlineListingRowDown({
        cats: [],
        tags: [],
        hoursNote: '',
        onlineDetails: {
          payments: ['card', 'bankTransfer'],
          sessionFormats: ['chat', 'inPerson'],
        },
      }).tags,
    ).toEqual([]);
  });

  it('keeps an hours note written after the migration', () => {
    expect(
      convertOnlineListingRowDown({
        cats: [],
        tags: [],
        hoursNote: 'Open Saturdays',
        onlineDetails: { replyNote: 'Replies within a day.' },
      }).hoursNote,
    ).toBe('Open Saturdays');
  });

  it('skips a NULL tag element while restoring the moved tags', () => {
    expect(
      convertOnlineListingRowDown({
        cats: [],
        tags: ['Made to order', null],
        hoursNote: '',
        onlineDetails: { payments: ['mbway'] },
      }).tags,
    ).toEqual(['Made to order', 'MB WAY']);
  });

  it('reads a row with no online details as nothing to restore', () => {
    expect(
      convertOnlineListingRowDown({
        cats: ['handmade'],
        tags: ['Gift cards'],
        hoursNote: null,
        onlineDetails: null,
      }),
    ).toEqual({ cats: ['design'], tags: ['Gift cards'], hoursNote: '' });
  });

  it('maps every category it moves back the way it came', () => {
    for (const [placeSlug, onlineSlug] of Object.entries(
      PLACE_TO_ONLINE_CATEGORY_AT_MIGRATION,
    )) {
      expect(ONLINE_TO_PLACE_CATEGORY_AT_MIGRATION[onlineSlug]).toBe(placeSlug);
    }
  });
});
