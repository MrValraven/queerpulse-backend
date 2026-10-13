// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` both require every `src/migrations/*.ts` file, and
// requiring a spec there throws `describe is not defined` before any
// migration runs. Same convention as `listing-online-details-migration.spec.ts`.
import {
  ATTRIBUTE_BY_OLD_VALUE_AT_MIGRATION,
  LANGS_OTHER_MAX_LENGTH_AT_MIGRATION,
  ListingRowBeforeAttributesUp,
  convertListingAttributesRowUp,
  convertListingLanguagesRowDown,
  restoreListingLanguagesRowDown,
} from './listing-attributes-migration';

const placeRow = (
  overrides: Partial<ListingRowBeforeAttributesUp> = {},
): ListingRowBeforeAttributesUp => ({
  online: false,
  cats: ['food'],
  tags: [],
  goodFor: [],
  langs: [],
  ...overrides,
});

describe('listing attributes migration, up', () => {
  it('maps tags, then Good-for values, whatever their case and padding, each slug once', () => {
    const converted = convertListingAttributesRowUp(
      placeRow({
        tags: [' vegan options ', 'TERRACE', 'Community events'],
        goodFor: ['Hosts community events', 'Dog-friendly', 'solo-friendly'],
      }),
    );

    expect(converted.attributes).toEqual([
      'vegan-options',
      'terrace',
      'hosts-events',
      'dog-friendly',
      'solo-friendly',
    ]);
  });

  it('maps every old value in the frozen table', () => {
    expect(ATTRIBUTE_BY_OLD_VALUE_AT_MIGRATION.size).toBe(30);
    expect(
      ATTRIBUTE_BY_OLD_VALUE_AT_MIGRATION.get('alcohol-free options'),
    ).toBe('alcohol-free-drinks');
  });

  it('drops the retired values, the access values and any free text', () => {
    const converted = convertListingAttributesRowUp(
      placeRow({
        tags: [
          'Gender-neutral pricing',
          'Late opening',
          'Budget-friendly',
          'Design studio',
        ],
        goodFor: [
          'Wheelchair accessible',
          'Gender-neutral toilets',
          'Step-free entrance',
          'Quiet, low-sensory hours',
          'Accessible bathroom',
          'A great second date',
        ],
      }),
    );

    expect(converted).toMatchObject({
      attributes: [],
      highlights: [],
      entryMode: null,
      coverPolicy: null,
    });
  });

  it('keeps the strictest way in when several are set', () => {
    expect(
      convertListingAttributesRowUp(
        placeRow({
          tags: ['Walk-ins welcome', 'Booking recommended'],
          goodFor: ['Members only'],
        }),
      ).entryMode,
    ).toBe('membersOnly');
    expect(
      convertListingAttributesRowUp(
        placeRow({
          tags: ['By appointment', 'Walk-ins welcome', 'Booking recommended'],
        }),
      ).entryMode,
    ).toBe('appointmentOnly');
    expect(
      convertListingAttributesRowUp(placeRow({ goodFor: ['walk-ins welcome'] }))
        .entryMode,
    ).toBe('walkIn');
  });

  it('turns By appointment on an online row into the online attribute and sets no way in', () => {
    const converted = convertListingAttributesRowUp(
      placeRow({
        online: true,
        cats: ['therapy'],
        tags: ['By appointment', 'Walk-ins welcome', 'Members only'],
      }),
    );

    expect(converted.attributes).toEqual(['by-appointment']);
    expect(converted.entryMode).toBeNull();
  });

  it('maps Free entry to a free cover on a nightlife or culture row only', () => {
    expect(
      convertListingAttributesRowUp(
        placeRow({ cats: ['culture'], tags: ['Free entry'] }),
      ),
    ).toMatchObject({ coverPolicy: 'free', attributes: [] });
    expect(
      convertListingAttributesRowUp(
        placeRow({ cats: ['food', 'nightlife'], goodFor: ['free entry'] }),
      ).coverPolicy,
    ).toBe('free');
    expect(
      convertListingAttributesRowUp(placeRow({ tags: ['Free entry'] })),
    ).toMatchObject({ coverPolicy: null, attributes: [] });
  });

  it('highlights the first three mapped attributes in source order', () => {
    expect(
      convertListingAttributesRowUp(
        placeRow({
          tags: ['Workshops', 'Classes'],
          goodFor: ['Dog-friendly', 'Solo-friendly'],
        }),
      ).highlights,
    ).toEqual(['workshops', 'classes', 'dog-friendly']);
  });

  it('maps an attribute whatever the row is offered today', () => {
    expect(
      convertListingAttributesRowUp(
        placeRow({ cats: ['grooming'], tags: ['DJ nights', 'Terrace'] }),
      ).attributes,
    ).toEqual(['dj-nights', 'terrace']);
  });

  it('reads null lists and null entries as empty', () => {
    expect(
      convertListingAttributesRowUp({
        online: null,
        cats: null,
        tags: [null, 'Terrace'],
        goodFor: null,
        langs: [null],
      }),
    ).toEqual({
      attributes: ['terrace'],
      highlights: ['terrace'],
      entryMode: null,
      coverPolicy: null,
      langs: [],
      langsOther: '',
    });
  });

  it('maps the old language names to codes, keeps codes whatever their case, and drops Other', () => {
    expect(
      convertListingAttributesRowUp(
        placeRow({
          langs: [
            'Português',
            'english',
            'Português (Brasil)',
            'PT',
            'LGP (sign)',
            'Other',
            'pt-br',
            'kea',
          ],
        }),
      ),
    ).toMatchObject({
      langs: ['pt', 'en', 'pt-BR', 'lgp', 'kea'],
      langsOther: '',
    });
  });

  it('moves any other language to langsOther, once each, joined', () => {
    expect(
      convertListingAttributesRowUp(
        placeRow({ langs: ['Tetum', 'Español', 'Crioulo da Guiné', 'tetum'] }),
      ),
    ).toMatchObject({ langs: ['es'], langsOther: 'Tetum, Crioulo da Guiné' });
  });

  it('keeps whole names that fill langsOther to exactly 80 characters', () => {
    const converted = convertListingAttributesRowUp(
      placeRow({ langs: ['A'.repeat(39), 'B'.repeat(39)] }),
    );

    expect(converted.langsOther).toBe(`${'A'.repeat(39)}, ${'B'.repeat(39)}`);
    expect(converted.langsOther).toHaveLength(
      LANGS_OTHER_MAX_LENGTH_AT_MIGRATION,
    );
  });

  it('leaves out a name that does not fit whole and keeps a later one that does', () => {
    expect(
      convertListingAttributesRowUp(
        placeRow({ langs: ['A'.repeat(50), 'B'.repeat(50), 'Tetum'] }),
      ).langsOther,
    ).toBe(`${'A'.repeat(50)}, Tetum`);
    expect(
      convertListingAttributesRowUp(placeRow({ langs: ['C'.repeat(81)] }))
        .langsOther,
    ).toBe('');
  });

  it('reads a value named like an object member as free text', () => {
    expect(
      convertListingAttributesRowUp(placeRow({ tags: ['constructor'] }))
        .attributes,
    ).toEqual([]);
  });
});

describe('listing attributes migration, down', () => {
  it('maps the six codes back to the old names, keeps other codes and appends langsOther', () => {
    expect(
      convertListingLanguagesRowDown({
        langs: ['pt', 'pt-BR', 'en', 'es', 'fr', 'lgp', 'de'],
        langsOther: 'Tetum, Kriolu ',
      }).langs,
    ).toEqual([
      'Português',
      'Português (Brasil)',
      'English',
      'Español',
      'Français',
      'LGP (sign)',
      'de',
      'Tetum',
      'Kriolu',
    ]);
  });

  it('round trips the old names through up and down', () => {
    const converted = convertListingAttributesRowUp(
      placeRow({ langs: ['Português', 'English', 'Tetum'] }),
    );

    expect(
      convertListingLanguagesRowDown({
        langs: converted.langs,
        langsOther: converted.langsOther,
      }).langs,
    ).toEqual(['Português', 'English', 'Tetum']);
  });

  it('keeps at most 20 entries, the old limit', () => {
    expect(
      convertListingLanguagesRowDown({
        langs: ['pt'],
        langsOther: Array.from(
          { length: 30 },
          (_entry, index) => `Language ${index}`,
        ).join(', '),
      }).langs,
    ).toHaveLength(20);
  });

  it('reads nulls as empty', () => {
    expect(
      convertListingLanguagesRowDown({ langs: null, langsOther: null }).langs,
    ).toEqual([]);
  });

  it('restores the backup exactly as stored when the row has one', () => {
    expect(
      restoreListingLanguagesRowDown({
        langsBeforeAttributes: ['  english ', 'Other', null, 'Tetum'],
        langs: ['en', 'de'],
        langsOther: 'Kriolu',
      }).langs,
    ).toEqual(['  english ', 'Other', null, 'Tetum']);
  });

  it('restores an empty backup as an empty list', () => {
    expect(
      restoreListingLanguagesRowDown({
        langsBeforeAttributes: [],
        langs: ['pt'],
        langsOther: 'Tetum',
      }).langs,
    ).toEqual([]);
  });

  it('converts the codes back when the row has no backup', () => {
    expect(
      restoreListingLanguagesRowDown({
        langsBeforeAttributes: null,
        langs: ['pt', 'de'],
        langsOther: 'Tetum',
      }).langs,
    ).toEqual(['Português', 'de', 'Tetum']);
  });
});
