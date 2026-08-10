import { BadRequestException } from '@nestjs/common';
import {
  validatePieceBrief,
  validatePieceCare,
} from './piece-jsonb.validation';

const VALID_BRIEF = {
  angle: 'A retrospective on the first decade of the club.',
  wants: ['founding member interview', 'archive photos'],
  avoid: 'Do not name the venue that closed under NDA.',
  wordCount: 1800,
  filedWords: null,
  rate: '$0.50/word',
  killFee: '25%',
  commissionedBy: 'Jordan Reyes',
  commissionedOn: '2026-07-01',
  art: 'Archive photos, TBD',
};

const VALID_CARE = {
  subjects: [
    {
      name: 'Alex Rivera',
      named: true,
      out: true,
      consent: 'given',
      reply: 'Happy to be named, thanks for checking.',
      note: '',
    },
    {
      name: 'A source who asked not to be identified',
      named: false,
      out: null,
      consent: 'pseudonym',
      reply: '',
      note: 'Use "Sam" throughout.',
    },
  ],
  contentNotes: ['discussion of past housing insecurity'],
  flags: [{ key: 'medical', on: false, note: '' }],
  read: null,
};

describe('validatePieceBrief', () => {
  it('returns the input unchanged for a valid brief', () => {
    expect(validatePieceBrief(VALID_BRIEF)).toBe(VALID_BRIEF);
  });

  it('returns null when the input is null', () => {
    expect(validatePieceBrief(null)).toBeNull();
  });

  it('throws when the input is not an object', () => {
    expect(() => validatePieceBrief('not-an-object')).toThrow(
      BadRequestException,
    );
  });

  it('throws when the input is an array', () => {
    expect(() => validatePieceBrief([])).toThrow(BadRequestException);
  });

  it('throws when wants is not a string array', () => {
    expect(() =>
      validatePieceBrief({
        ...VALID_BRIEF,
        wants: 'founding member interview',
      }),
    ).toThrow(BadRequestException);
  });

  it('throws when wants contains a non-string entry', () => {
    expect(() =>
      validatePieceBrief({ ...VALID_BRIEF, wants: ['ok', 42] }),
    ).toThrow(BadRequestException);
  });

  it('throws when a required string field is missing', () => {
    const withoutAngle: Record<string, unknown> = { ...VALID_BRIEF };
    delete withoutAngle.angle;
    expect(() => validatePieceBrief(withoutAngle)).toThrow(BadRequestException);
  });

  it('accepts wordCount/filedWords as null', () => {
    expect(
      validatePieceBrief({ ...VALID_BRIEF, wordCount: null, filedWords: null }),
    ).toEqual({ ...VALID_BRIEF, wordCount: null, filedWords: null });
  });

  it('throws when wordCount is not a number or null', () => {
    expect(() =>
      validatePieceBrief({ ...VALID_BRIEF, wordCount: '1800' }),
    ).toThrow(BadRequestException);
  });
});

describe('validatePieceCare', () => {
  it('returns the input unchanged for valid care', () => {
    expect(validatePieceCare(VALID_CARE)).toBe(VALID_CARE);
  });

  it('allows care.read to be null', () => {
    expect(validatePieceCare(VALID_CARE)?.read).toBeNull();
  });

  it('returns null when the input is null', () => {
    expect(validatePieceCare(null)).toBeNull();
  });

  it('accepts a fully populated read record', () => {
    const careWithRead = {
      ...VALID_CARE,
      read: {
        reader: 'Priya Nair',
        role: 'sensitivity_reader',
        status: 'in_progress',
        askedOn: '2026-07-10',
        dueOn: '2026-07-20',
        checks: [{ label: 'Language around disability', done: true }],
      },
    };
    expect(validatePieceCare(careWithRead)).toBe(careWithRead);
  });

  it('throws when the input is not an object', () => {
    expect(() => validatePieceCare(42)).toThrow(BadRequestException);
  });

  it('throws when the input is an array', () => {
    expect(() => validatePieceCare([])).toThrow(BadRequestException);
  });

  it('throws when a subject has an out-of-union consent value', () => {
    expect(() =>
      validatePieceCare({
        ...VALID_CARE,
        subjects: [{ ...VALID_CARE.subjects[0], consent: 'maybe' }],
      }),
    ).toThrow(BadRequestException);
  });

  it('throws when subjects is not an array', () => {
    expect(() => validatePieceCare({ ...VALID_CARE, subjects: {} })).toThrow(
      BadRequestException,
    );
  });

  it('throws when contentNotes is not a string array', () => {
    expect(() =>
      validatePieceCare({ ...VALID_CARE, contentNotes: [true] }),
    ).toThrow(BadRequestException);
  });

  it('throws when a flag is missing a required field', () => {
    expect(() =>
      validatePieceCare({
        ...VALID_CARE,
        flags: [{ key: 'medical', on: true }],
      }),
    ).toThrow(BadRequestException);
  });

  it('throws when read is present but missing a required field', () => {
    expect(() =>
      validatePieceCare({
        ...VALID_CARE,
        read: {
          reader: 'Priya Nair',
          role: 'sensitivity_reader',
          status: 'in_progress',
          askedOn: '2026-07-10',
          dueOn: '2026-07-20',
          checks: 'not-an-array',
        },
      }),
    ).toThrow(BadRequestException);
  });
});
