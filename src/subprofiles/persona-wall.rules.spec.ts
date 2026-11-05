import {
  isPersonaWallFillOrder,
  lisbonWallDay,
  normalizeWallSearchTerm,
  personaWallPublicStateOf,
} from './persona-wall.rules';
import { PERSONA_WALL_FILL_ORDERS } from './persona-wall.constants';
import {
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';

const SHOWN_PERSONA = {
  status: SubprofileStatus.Published,
  visibility: SubprofileVisibility.Open,
  removedAt: null,
};

describe('personaWallPublicStateOf', () => {
  it('reads shown for a published, open, kept persona with no takedown', () => {
    expect(personaWallPublicStateOf(SHOWN_PERSONA, false)).toBe('shown');
  });

  it('answers the first matching state in contract order', () => {
    const everyState = {
      status: SubprofileStatus.Draft,
      visibility: SubprofileVisibility.Private,
      removedAt: new Date(),
    };
    expect(personaWallPublicStateOf(everyState, true)).toBe('removed');
    expect(
      personaWallPublicStateOf({ ...everyState, removedAt: null }, true),
    ).toBe('taken_down');
    expect(
      personaWallPublicStateOf({ ...everyState, removedAt: null }, false),
    ).toBe('draft');
    expect(
      personaWallPublicStateOf(
        { ...SHOWN_PERSONA, visibility: SubprofileVisibility.Network },
        false,
      ),
    ).toBe('not_open');
  });
});

describe('isPersonaWallFillOrder', () => {
  it('accepts the four orders only', () => {
    expect(
      PERSONA_WALL_FILL_ORDERS.every((fillOrder) =>
        isPersonaWallFillOrder(fillOrder),
      ),
    ).toBe(true);
    for (const value of [
      'shuffle',
      'ENDORSED',
      '',
      5,
      null,
      undefined,
      ['endorsed'],
    ]) {
      expect(isPersonaWallFillOrder(value)).toBe(false);
    }
  });
});

describe('lisbonWallDay', () => {
  it('turns over at Lisbon midnight in summer time', () => {
    expect(lisbonWallDay(new Date('2026-07-01T22:59:59Z'))).toBe('2026-07-01');
    expect(lisbonWallDay(new Date('2026-07-01T23:00:00Z'))).toBe('2026-07-02');
  });

  it('turns over at Lisbon midnight in winter time', () => {
    expect(lisbonWallDay(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
    expect(lisbonWallDay(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });
});

describe('normalizeWallSearchTerm', () => {
  it('trims and answers empty for blank or non-string input', () => {
    expect(normalizeWallSearchTerm('  ana ')).toBe('ana');
    for (const value of ['   ', undefined, null, 5, ['ana', 'rui']]) {
      expect(normalizeWallSearchTerm(value)).toBe('');
    }
  });

  it('cuts a long term to 100 code points without splitting an emoji', () => {
    expect(normalizeWallSearchTerm('🌈'.repeat(150))).toBe('🌈'.repeat(100));
  });
});
