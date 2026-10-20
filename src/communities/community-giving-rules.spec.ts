import { BadRequestException } from '@nestjs/common';
import {
  GivingInput,
  NormalizedGiving,
  diffGiving,
  normalizeGivingInput,
  normalizeGivingLink,
  normalizeIban,
  normalizeMbwayNumber,
  summarizeGivingMethod,
} from './community-giving-rules';
import { CommunityGivingKind } from './entities/community-giving-method.entity';

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('normalizeIban', () => {
  it('accepts a grouped lowercase IBAN with NBSP and a label', () => {
    expect(normalizeIban('IBAN: pt50 0002 0123 1234 5678 9015 4')).toBe(
      'PT50000201231234567890154',
    );
  });
  it('accepts DE and GB examples', () => {
    expect(normalizeIban('DE89 3704 0044 0532 0130 00')).toBe(
      'DE89370400440532013000',
    );
    expect(normalizeIban('GB82-WEST-1234-5698-7654-32')).toBe(
      'GB82WEST12345698765432',
    );
  });
  it('refuses a bad checksum, a wrong length and an unknown country', () => {
    expect(normalizeIban('PT50000201231234567890155')).toBeNull();
    expect(normalizeIban('PT5000020123123456789015')).toBeNull();
    expect(normalizeIban('ZZ50000201231234567890154')).toBeNull();
  });
});

describe('normalizeMbwayNumber', () => {
  it.each([
    ['912345678', '912345678'],
    ['+351 912 345 678', '912345678'],
    ['00351912345678', '912345678'],
    ['96 123 4567', '961234567'],
    ['93 123 45 67', '931234567'],
    ['912 345 678', '912345678'],
    ['  +351912345678 ', '912345678'],
  ])('accepts %p', (input, expected) => {
    expect(normalizeMbwayNumber(input)).toBe(expected);
  });
  it.each([
    '212345678',
    '91234567',
    '9123456789',
    '94 123 4567',
    '351912345678',
  ])('refuses %p', (input) => {
    expect(normalizeMbwayNumber(input)).toBeNull();
  });
});

describe('normalizeGivingLink', () => {
  it('keeps a trimmed https URL as entered', () => {
    expect(normalizeGivingLink('  https://ko-fi.com/queerpulse ')).toBe(
      'https://ko-fi.com/queerpulse',
    );
  });
  it('accepts an uppercase scheme and keeps it as entered', () => {
    expect(normalizeGivingLink('HTTPS://ko-fi.com/x')).toBe(
      'HTTPS://ko-fi.com/x',
    );
  });
  it.each([
    'http://ko-fi.com/x',
    'ko-fi.com/x',
    'javascript:alert(1)',
    'data:text/html,x',
    'https://user:pass@ko-fi.com/x',
    'https://',
    'https:ko-fi.com/x',
    'https:\\\\ko-fi.com\\x',
    'https://ko-fi.com/a b',
    'https://ko-fi.com/a\tb',
  ])('refuses %p', (input) => {
    expect(normalizeGivingLink(input)).toBeNull();
  });
});

describe('normalizeGivingInput', () => {
  it('throws GIVING_TOO_MANY_METHODS past 8 rows, before reading any value', () => {
    const input: GivingInput = {
      intro: null,
      methods: Array.from({ length: 9 }, () => ({
        kind: CommunityGivingKind.Link,
        value: 'bad',
      })),
    };

    const error = captureError(() => normalizeGivingInput(input));

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse();
    expect(body).toMatchObject({ code: 'GIVING_TOO_MANY_METHODS' });
    expect(body).not.toHaveProperty('index');
  });

  it('throws the kind code with the row index, and the message never contains the value', () => {
    const input: GivingInput = {
      intro: null,
      methods: [
        { kind: CommunityGivingKind.Link, value: 'https://ko-fi.com/q' },
        { kind: CommunityGivingKind.Iban, value: 'PT50000201231234567890155' },
      ],
    };

    const error = captureError(() => normalizeGivingInput(input));

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse();
    expect(body).toMatchObject({ code: 'GIVING_IBAN_INVALID', index: 1 });
    expect(JSON.stringify(body)).not.toContain('PT5000020123');
  });

  it('stores empty or tag-only intro, label and note as null', () => {
    const normalized = normalizeGivingInput({
      intro: '  ',
      methods: [
        {
          kind: CommunityGivingKind.Link,
          value: 'https://ko-fi.com/q',
          label: '<b></b>',
          note: '',
        },
      ],
    });

    expect(normalized.intro).toBeNull();
    expect(normalized.methods[0]?.label).toBeNull();
    expect(normalized.methods[0]?.note).toBeNull();
  });

  it('returns canonical values in input order', () => {
    const normalized = normalizeGivingInput({
      intro: 'Help us keep the lights on',
      methods: [
        {
          kind: CommunityGivingKind.Link,
          value: ' https://ko-fi.com/queerpulse ',
        },
        { kind: CommunityGivingKind.Mbway, value: '+351 912 345 678' },
        {
          kind: CommunityGivingKind.Iban,
          value: 'pt50 0002 0123 1234 5678 9015 4',
        },
      ],
    });

    expect(normalized.methods.map((method) => method.kind)).toEqual([
      CommunityGivingKind.Link,
      CommunityGivingKind.Mbway,
      CommunityGivingKind.Iban,
    ]);
    expect(normalized.methods.map((method) => method.value)).toEqual([
      'https://ko-fi.com/queerpulse',
      '912345678',
      'PT50000201231234567890154',
    ]);
  });
});

describe('summarizeGivingMethod', () => {
  it('formats kind name, quoted label, value and note', () => {
    expect(
      summarizeGivingMethod({
        kind: CommunityGivingKind.Iban,
        label: 'Main account',
        value: 'PT50000201231234567890154',
        note: 'Associação Exemplo',
      }),
    ).toBe(
      'IBAN "Main account": PT50000201231234567890154 (Associação Exemplo)',
    );
    expect(
      summarizeGivingMethod({
        kind: CommunityGivingKind.Link,
        label: null,
        value: 'https://ko-fi.com/q',
        note: null,
      }),
    ).toBe('Link: https://ko-fi.com/q');
    expect(
      summarizeGivingMethod({
        kind: CommunityGivingKind.Mbway,
        label: 'Treasurer',
        value: '912345678',
        note: null,
      }),
    ).toBe('MB WAY "Treasurer": 912345678');
  });
});

describe('diffGiving', () => {
  const linkMethod = {
    kind: CommunityGivingKind.Link,
    label: null,
    value: 'https://ko-fi.com/q',
    note: null,
  };
  const mbwayMethod = {
    kind: CommunityGivingKind.Mbway,
    label: 'Treasurer',
    value: '912345678',
    note: null,
  };
  const baseline: NormalizedGiving = {
    intro: 'old',
    methods: [linkMethod, mbwayMethod],
  };

  it('is empty for identical sets', () => {
    expect(
      diffGiving(baseline, {
        intro: 'old',
        methods: [{ ...linkMethod }, { ...mbwayMethod }],
      }),
    ).toEqual({});
  });

  it('reports only the intro when only the intro changed', () => {
    const changes = diffGiving(baseline, { ...baseline, intro: null });

    expect(Object.keys(changes)).toEqual(['givingIntro']);
    expect(changes.givingIntro).toEqual({ from: 'old', to: null });
  });

  it('counts methods whose summaries collide as changed', () => {
    const beforeMethod = {
      kind: CommunityGivingKind.Link,
      label: 'X": https://a (n',
      value: 'https://b)',
      note: null,
    };
    const afterMethod = {
      kind: CommunityGivingKind.Link,
      label: 'X',
      value: 'https://a',
      note: 'n": https://b',
    };
    expect(summarizeGivingMethod(beforeMethod)).toBe(
      summarizeGivingMethod(afterMethod),
    );

    const changes = diffGiving(
      { intro: null, methods: [beforeMethod] },
      { intro: null, methods: [afterMethod] },
    );

    expect(Object.keys(changes)).toEqual(['givingMethods']);
  });

  it('reports a reorder as a givingMethods change with both summary lists', () => {
    const changes = diffGiving(baseline, {
      intro: 'old',
      methods: [mbwayMethod, linkMethod],
    });

    expect(Object.keys(changes)).toEqual(['givingMethods']);
    expect(changes.givingMethods).toEqual({
      from: ['Link: https://ko-fi.com/q', 'MB WAY "Treasurer": 912345678'],
      to: ['MB WAY "Treasurer": 912345678', 'Link: https://ko-fi.com/q'],
    });
  });
});
