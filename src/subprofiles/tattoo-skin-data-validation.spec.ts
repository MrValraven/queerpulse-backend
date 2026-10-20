import { BadRequestException } from '@nestjs/common';
import {
  assertValidTattooSkinData,
  findTattooSkinDataViolation,
} from './tattoo-skin-data-validation';

const NOW = new Date('2026-10-19T12:00:00Z');

function buildFullTattooSkin(): Record<string, unknown> {
  return {
    tattoo: {
      status: 'waitlist',
      nextOpening: '2026-12-01',
      waitNote: 'Spring',
    },
    tattooBooking: {
      route: 'email',
      email: 'artist@example.com',
      formUrl: 'https://example.com/book',
      whatToSend: ['idea', 'placement', 'size'],
      consultation: 'both',
      replyTime: 'Within a week',
    },
    tattooStyles: {
      styles: ['fine_line', 'Botanical blackwork'],
      colour: 'black_grey',
      minSize: '5 cm',
      doesNotDo: ['Portraits', 'Names'],
    },
    tattooPrices: {
      minimum: '80',
      hourly: '120,50',
      dayRate: '600.',
      deposit: {
        amount: '50',
        isRefundable: true,
        note: 'Booked against the session',
      },
      cancellation: 'Forty-eight hours notice',
      touchUps: { isFree: true, months: '12' },
    },
    tattooComfort: {
      options: ['private_room', 'breaks_any_time'],
      note: 'Ask anything',
    },
    tattooHygiene: { practices: ['single_use_needles', 'licensed_studio'] },
    tattooScarWork: {
      intro: 'Scar work is a favourite',
      hasFreeConsult: true,
      hasReducedPrice: true,
      reducedPriceNote: 'Ask about it',
    },
    tattooStudio: {
      city: 'Lisbon',
      isPrivateStudio: true,
      isByAppointmentOnly: false,
    },
    tattooLineage: {
      trainedWith: 'A long apprenticeship',
      tattooingSince: '2014',
      isTakingApprentices: true,
      apprenticeNote: 'Open once a year',
      teaches: ['Handpoke basics'],
    },
  };
}

function violationFor(blockKey: string, block: unknown): string | null {
  return findTattooSkinDataViolation({ [blockKey]: block }, NOW);
}

describe('tattoo skin data validation', () => {
  it('accepts a full tattoo skin with every block filled', () => {
    expect(findTattooSkinDataViolation(buildFullTattooSkin(), NOW)).toBeNull();
  });

  it('accepts a skin with no tattoo keys and null tattoo blocks', () => {
    expect(findTattooSkinDataViolation({}, NOW)).toBeNull();
    expect(
      findTattooSkinDataViolation(
        { tattoo: null, tattooBooking: null, tattooPrices: null },
        NOW,
      ),
    ).toBeNull();
    expect(findTattooSkinDataViolation(null, NOW)).toBeNull();
  });

  it('leaves faq and venue to the editor', () => {
    const faq = Array.from({ length: 50 }, (_unused, entryIndex) => ({
      question: `Question ${entryIndex}`,
      answer: 'Answer',
    }));
    expect(
      findTattooSkinDataViolation(
        { faq, venue: { name: 'x', lines: [] } },
        NOW,
      ),
    ).toBeNull();
  });

  it('accepts an empty route, consultation and colour', () => {
    expect(
      violationFor('tattooBooking', {
        route: '',
        consultation: '',
        email: '',
        formUrl: '',
        replyTime: '',
      }),
    ).toBeNull();
    expect(
      violationFor('tattooStyles', { colour: '', minSize: '' }),
    ).toBeNull();
    expect(
      violationFor('tattoo', { status: '', nextOpening: '', waitNote: '' }),
    ).toBeNull();
    expect(
      violationFor('tattooPrices', {
        minimum: '',
        deposit: { amount: '' },
        touchUps: { months: '' },
      }),
    ).toBeNull();
    expect(violationFor('tattooLineage', { tattooingSince: '' })).toBeNull();
  });

  it('refuses the therapist status value wait', () => {
    expect(violationFor('tattoo', { status: 'wait' })).toBe('tattoo.status');
  });

  it('refuses an unknown sub-key', () => {
    expect(
      violationFor('tattoo', { status: 'open', colour: 'black_grey' }),
    ).toBe('tattoo.colour');
  });

  it('refuses nextOpening 2026-13-01', () => {
    expect(violationFor('tattoo', { nextOpening: '2026-13-01' })).toBe(
      'tattoo.nextOpening',
    );
  });

  it('refuses an email without an at sign', () => {
    expect(violationFor('tattooBooking', { email: 'artist.example.com' })).toBe(
      'tattooBooking.email',
    );
  });

  it('refuses an http:// form link', () => {
    expect(
      violationFor('tattooBooking', { formUrl: 'http://example.com/book' }),
    ).toBe('tattooBooking.formUrl');
  });

  it('refuses duplicate whatToSend entries', () => {
    expect(
      violationFor('tattooBooking', { whatToSend: ['idea', 'size', 'size'] }),
    ).toBe('tattooBooking.whatToSend.2');
    expect(
      violationFor('tattooBooking', { whatToSend: ['idea', 'idea'] }),
    ).toBe('tattooBooking.whatToSend.1');
  });

  it('refuses an empty custom style', () => {
    expect(violationFor('tattooStyles', { styles: ['fine_line', '  '] })).toBe(
      'tattooStyles.styles.1',
    );
  });

  it('refuses 21 styles', () => {
    const styles = Array.from(
      { length: 21 },
      (_unused, styleIndex) => `Style ${styleIndex}`,
    );
    expect(violationFor('tattooStyles', { styles })).toBe(
      'tattooStyles.styles',
    );
    expect(
      violationFor('tattooStyles', { styles: styles.slice(0, 20) }),
    ).toBeNull();
  });

  it('refuses a deposit of 1234567', () => {
    expect(
      violationFor('tattooPrices', { deposit: { amount: '1234567' } }),
    ).toBe('tattooPrices.deposit.amount');
  });

  it('refuses touch-ups within 25 months', () => {
    expect(violationFor('tattooPrices', { touchUps: { months: '25' } })).toBe(
      'tattooPrices.touchUps.months',
    );
    expect(
      violationFor('tattooPrices', { touchUps: { months: '24' } }),
    ).toBeNull();
    expect(violationFor('tattooPrices', { touchUps: { months: '0' } })).toBe(
      'tattooPrices.touchUps.months',
    );
  });

  it('refuses tattooingSince 1899 and 2027', () => {
    expect(violationFor('tattooLineage', { tattooingSince: '1899' })).toBe(
      'tattooLineage.tattooingSince',
    );
    expect(violationFor('tattooLineage', { tattooingSince: '2027' })).toBe(
      'tattooLineage.tattooingSince',
    );
    expect(
      violationFor('tattooLineage', { tattooingSince: '2026' }),
    ).toBeNull();
    expect(
      violationFor('tattooLineage', { tattooingSince: '1900' }),
    ).toBeNull();
  });

  it('refuses a hygiene note', () => {
    expect(
      violationFor('tattooHygiene', {
        practices: ['licensed_studio'],
        note: 'Extra',
      }),
    ).toBe('tattooHygiene.note');
  });

  it('refuses a string where a boolean belongs', () => {
    expect(violationFor('tattooStudio', { isPrivateStudio: 'yes' })).toBe(
      'tattooStudio.isPrivateStudio',
    );
  });

  it('refuses a block that is a string', () => {
    expect(violationFor('tattooBooking', 'email me')).toBe('tattooBooking');
  });

  it('throws 400 TATTOO_SKIN_INVALID with the path', () => {
    let thrown: unknown;
    try {
      assertValidTattooSkinData(
        { tattooPrices: { deposit: { amount: '1234567' } } },
        NOW,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const exception = thrown as BadRequestException;
    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual(
      expect.objectContaining({
        code: 'TATTOO_SKIN_INVALID',
        message: expect.stringContaining('tattooPrices.deposit.amount'),
      }),
    );
    expect(() =>
      assertValidTattooSkinData(buildFullTattooSkin(), NOW),
    ).not.toThrow();
  });
});
