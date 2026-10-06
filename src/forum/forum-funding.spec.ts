import { HttpException } from '@nestjs/common';
import {
  ASK_AUTO_END_MS,
  FUNDING_LINK_HOST_ALLOW_LIST,
  IBAN_LENGTH_BY_COUNTRY,
  OPEN_CALL_TAG,
  PT_MOBILE_PATTERN,
  containsPaymentDetails,
  deriveAskState,
  deriveCallState,
  fundingException,
  hasDeadlineChanged,
  isAllowListedFundingHost,
  isFundingCategory,
  isFundingKind,
  normalizeFundingLink,
  stripLeadingWww,
  validateFundingInput,
  withServerOwnedFundingTag,
} from './forum-funding';

const NOW = new Date('2026-10-05T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('normalizeFundingLink', () => {
  it('drops www, case, tracking parameters, the fragment and a trailing slash from the key', () => {
    expect(
      normalizeFundingLink(
        'https://www.GoFundMe.com/f/help-ana/?utm_source=ig&utm_medium=social#donate',
      ),
    ).toEqual({
      linkUrl:
        'https://www.gofundme.com/f/help-ana/?utm_source=ig&utm_medium=social#donate',
      linkHost: 'gofundme.com',
      linkKey: 'gofundme.com/f/help-ana',
    });
  });

  it('gives every spelling of one call the same key', () => {
    const spellings = [
      'https://gofundme.com/f/help-ana',
      'https://www.gofundme.com/f/help-ana/',
      'https://gofundme.com/f/help-ana?fbclid=abc123',
      '  https://GOFUNDME.com/f/help-ana#top  ',
    ];
    const keys = spellings.map(
      (spelling) => normalizeFundingLink(spelling)?.linkKey,
    );
    expect(new Set(keys)).toEqual(new Set(['gofundme.com/f/help-ana']));
  });

  it.each([
    ['plain http', 'http://gofundme.com/f/help-ana'],
    ['a missing scheme', 'gofundme.com/f/help-ana'],
    [
      'a credential prefix hiding the real host',
      'https://gofundme.com@evil.io/f/help-ana',
    ],
    ['a script url', 'javascript:alert(1)'],
    ['a host with no dot', 'https://localhost/f/help-ana'],
    ['an empty string', ''],
  ])('refuses %s', (_label, raw) => {
    expect(normalizeFundingLink(raw)).toBeNull();
  });

  it('keeps parameters that select the page and sorts them in the key', () => {
    const keyOf = (raw: string) => normalizeFundingLink(raw)?.linkKey;
    expect(keyOf('https://funder.pt/concurso?id=123')).not.toBe(
      keyOf('https://funder.pt/concurso?id=124'),
    );
    expect(keyOf('https://funder.pt/concurso?utm_source=x&id=123')).toBe(
      keyOf('https://funder.pt/concurso?id=123'),
    );
    expect(
      keyOf('https://funder.pt/c?b=2&a=1&mc_cid=z&gclid=q&igshid=1&ref=x'),
    ).toBe('funder.pt/c?a=1&b=2');
    expect(keyOf('https://funder.pt/c?a=1&b=2')).toBe(
      keyOf('https://funder.pt/c?b=2&a=1'),
    );
  });

  it('refuses a link whose percent-encoded form outgrows its column', () => {
    expect(
      normalizeFundingLink(
        `https://gofundme.com/x?utm_source=${'ã'.repeat(400)}`,
      ),
    ).toBeNull();
  });

  it('refuses an empty host label', () => {
    expect(normalizeFundingLink('https://www./x')).toBeNull();
    expect(normalizeFundingLink('https://gulbenkian..pt/x')).toBeNull();
  });

  it('refuses a key longer than its column', () => {
    expect(
      normalizeFundingLink(`https://gofundme.com/${'a'.repeat(600)}`),
    ).toBeNull();
  });
});

describe('isAllowListedFundingHost', () => {
  it.each(
    FUNDING_LINK_HOST_ALLOW_LIST.flatMap((host) => [
      `https://${host}/campaign`,
      `https://www.${host}/campaign`,
    ]),
  )('accepts %s', (url) => {
    const link = normalizeFundingLink(url);
    expect(link !== null && isAllowListedFundingHost(link.linkHost)).toBe(true);
  });

  it.each([
    'https://gofundme.com.evil.io/f/help-ana',
    'https://evilgofundme.com/f/help-ana',
    'https://www.www.gofundme.com/f/help-ana',
    'https://gofundme.co/f/help-ana',
    'https://gofündme.com/f/help-ana',
    'https://gofundme.com./f/help-ana',
    'https://uk.gofundme.com/f/help-ana',
  ])('refuses %s', (url) => {
    const link = normalizeFundingLink(url);
    expect(link !== null && isAllowListedFundingHost(link.linkHost)).toBe(
      false,
    );
  });
});

describe('containsPaymentDetails', () => {
  it.each([
    'Transfer to PT50 0002 0123 1234 5678 9015 4 please',
    'IBAN:PT50000201231234567890154',
    'IBAN DE89 3704 0044 0532 0130 00',
    'GB29 NWBK 6016 1331 9268 19',
    'pt50 0002 0123 1234 5678 9015 4',
    'iban pt50000201231234567890154',
    'Pt50 0002 0123 1234 5678 9015 4',
    'PT50-0002-0123-1234-5678-9015-4',
    'PT50.0002.0123.1234.5678.9015.4',
    'PT50\u00A00002\u00A00123\u00A01234\u00A05678\u00A09015\u00A04',
    'PT50\u202F0002\u202F0123\u202F1234\u202F5678\u202F9015\u202F4',
    'PT50  0002  0123  1234  5678  9015  4',
    'DE89370400440532013000',
    'GB82WEST12345698765432',
    'IBANpt50000201231234567890154',
    'PT2030 IBAN PT50 0002 0123 1234 5678 9015 4',
    'Ref AB12 PT50 0002 0123 1234 5678 9015 4',
    'EU2026 PT50000201231234567890154',
    'xx99 PT50000201231234567890154',
    'MB Way 912 345 678',
    'ligar +351 912 345 678',
    'ligar +351912345678',
    'ligar 00351912345678',
    'ligar 912-345-678',
    'ligar +351-962-345-678',
    'telemóvel 936345678 obrigado',
    'ligar 91 234 5678',
    'ligar +351 91 234 5678',
    'ligar 91 234 56 78',
    'ligar 912.345.678',
    'MB Way 912  345  678',
    'ligar 912 - 345 - 678',
    'ligar +351   912 345 678',
  ])('flags %s', (text) => {
    expect(containsPaymentDetails(text)).toBe(true);
  });

  it.each([
    'We need 2500 EUR by May 2027 for the PT 2026 tour',
    'EU 2026 PROJECT FUNDING GOAL REACHED',
    'Call the association on 213 456 789',
    'Order reference 1912345678',
    'Meet at 19:30 on 12/10, room 4',
    'NIF 512345678',
    'EU2026 PROJECT FUNDING 2027 2028',
    'AB12 2024 2025 2026',
    'PT2030 printing queer share and with',
    'Horizon2020 funding helps queer arts groups reach more people',
    'Covid19 recovery grants for community centres and with partners',
    'Pride2026 programme budget for printing and the stage hire',
    'PT50 0002 0123 1234 5678 9015 5',
    'Call 213 456 789 or 21 345 6789',
    'Call 22 345 6789',
    'Order 1912345678',
    'PT2030 1000 2024 150 30 month',
    'Covid19 grants 2026 for 150 centres in 30 towns',
    'Call 213  456  789',
  ])('leaves %s alone', (text) => {
    expect(containsPaymentDetails(text)).toBe(false);
  });

  // Real registry examples, one per length class worth pinning: the shortest
  // (NO, 15), the longest in use (LC, 32), letters inside the BBAN (MT, BR,
  // FR, IT) and the common European ones, grouped and solid.
  it.each([
    'BE68 5390 0754 7034',
    'NO93 8601 1117 947',
    'MT84 MALT 0110 0001 2345 MTLC AST0 01S',
    'LC55 HEMM 0001 0001 0012 0012 0002 3015',
    'BR18 0036 0305 0000 1000 9795 493C 1',
    'FR14 2004 1010 0505 0001 3M02 606',
    'IT60X0542811101000000123456',
    'CH93 0076 2011 6238 5295 7',
    'ES91 2100 0418 4502 0005 1332',
    'NL91 ABNA 0417 1643 00',
    'IE29 AIBK 9311 5212 3456 78',
    'LU28 0019 4006 4475 0000',
    'AT61 1904 3002 3457 3201',
  ])('flags the registry example %s', (iban) => {
    expect(containsPaymentDetails(`IBAN ${iban}`)).toBe(true);
  });

  it('leaves a candidate alone when it is not its country length, checksum or not', () => {
    // 24 characters with a valid mod-97 checksum; a Portuguese IBAN has 25.
    const oneShort = 'PT5600020123123456789015';
    const portugueseLength = IBAN_LENGTH_BY_COUNTRY.PT ?? 0;
    expect(portugueseLength).toBe(25);
    expect(oneShort).toHaveLength(portugueseLength - 1);
    expect(containsPaymentDetails(`IBAN ${oneShort}`)).toBe(false);
  });

  it('leaves a country code outside the registry alone', () => {
    expect(IBAN_LENGTH_BY_COUNTRY.ID).toBeUndefined();
    expect(containsPaymentDetails('ID12 0002 0123 1234 5678 9015 4')).toBe(
      false,
    );
  });
});

describe('IBAN_LENGTH_BY_COUNTRY', () => {
  it.each([
    ['PT', 25],
    ['DE', 22],
    ['GB', 22],
    ['FR', 27],
    ['ES', 24],
    ['NL', 18],
    ['BE', 16],
    ['IT', 27],
    ['IE', 22],
    ['LU', 20],
    ['CH', 21],
    ['AT', 20],
    ['NO', 15],
    ['MT', 31],
    ['LC', 32],
    ['BR', 29],
    ['RU', 33],
  ])('gives %s the registry length %i', (countryCode, length) => {
    expect(IBAN_LENGTH_BY_COUNTRY[countryCode]).toBe(length);
  });

  it('keeps every entry a two-letter code and a length the format allows', () => {
    const entries = Object.entries(IBAN_LENGTH_BY_COUNTRY);
    expect(entries.length).toBeGreaterThanOrEqual(89);
    for (const [countryCode, length] of entries) {
      expect(countryCode).toMatch(/^[A-Z]{2}$/);
      expect(length).toBeGreaterThanOrEqual(15);
      expect(length).toBeLessThanOrEqual(34);
    }
  });
});

describe('PT_MOBILE_PATTERN', () => {
  it('takes up to three separators between groups and no more', () => {
    expect(PT_MOBILE_PATTERN.test('912   345   678')).toBe(true);
    expect(PT_MOBILE_PATTERN.test('912    345    678')).toBe(false);
  });
});

describe('validateFundingInput: calls', () => {
  const validCall = {
    linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer/',
    funderName: '  Fundação Gulbenkian  ',
    amountMin: 1000,
    amountMax: 5000,
    deadline: '2026-12-01T23:59:00.000Z',
    eligibility: ['individuals', 'collectives', 'individuals'],
    scope: 'national',
    goalAmount: 900,
  };

  it('resolves a complete call and drops the fields that belong to asks', () => {
    expect(validateFundingInput('call', validCall, { now: NOW })).toEqual({
      ok: true,
      value: {
        kind: 'call',
        linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer/',
        linkHost: 'gulbenkian.pt',
        linkKey: 'gulbenkian.pt/bolsas/arte-queer',
        funderName: 'Fundação Gulbenkian',
        amountMin: 1000,
        amountMax: 5000,
        deadline: new Date('2026-12-01T23:59:00.000Z'),
        eligibility: ['individuals', 'collectives'],
        scope: 'national',
        goalAmount: null,
        askPurpose: null,
        beneficiary: null,
        endsAt: null,
      },
    });
  });

  it('treats a missing deadline as a rolling call', () => {
    const result = validateFundingInput(
      'call',
      { ...validCall, deadline: null },
      { now: NOW },
    );
    expect(result.ok && result.value.deadline).toBeNull();
  });

  it.each([
    ['no funder', { funderName: '   ' }],
    ['no scope', { scope: undefined }],
    ['an unknown scope', { scope: 'galactic' }],
    ['an upside-down range', { amountMin: 5000, amountMax: 1000 }],
    ['cents', { amountMin: 10.5 }],
    ['a negative amount', { amountMax: -1 }],
    ['an unknown eligibility', { eligibility: ['everyone'] }],
    ['a past deadline', { deadline: '2026-10-01T00:00:00.000Z' }],
    ['a deadline three years out', { deadline: '2029-10-05T09:00:00.000Z' }],
    ['an unparsable deadline', { deadline: 'next friday' }],
    ['a deadline with no time zone', { deadline: '2026-12-01T23:59' }],
    ['a date-only deadline', { deadline: '2026-12-01' }],
    ['a calendar rollover deadline', { deadline: '2026-02-30T10:00:00Z' }],
  ])('reports %s as funding_details_required', (_label, override) => {
    const result = validateFundingInput(
      'call',
      { ...validCall, ...override },
      { now: NOW },
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'funding_details_required' }),
    );
  });

  it.each([
    [
      '2026-12-01T23:59',
      'deadline needs a time zone, like 2026-12-01T23:59:00Z',
    ],
    [
      'next friday',
      'deadline must be a date and time like 2026-12-01T23:59:00Z or 2026-12-01T23:59:00+01:00',
    ],
    [
      '2026-12-01T23:59:00+0100',
      'deadline must be a date and time like 2026-12-01T23:59:00Z or 2026-12-01T23:59:00+01:00',
    ],
    [
      '2026-12-01T23:59:00z',
      'deadline must be a date and time like 2026-12-01T23:59:00Z or 2026-12-01T23:59:00+01:00',
    ],
    [
      '2026-12-01T23:59:00.123456Z',
      'deadline must be a date and time like 2026-12-01T23:59:00Z or 2026-12-01T23:59:00+01:00',
    ],
    [
      '2026-02-30T10:00:00Z',
      'deadline must be a date and time like 2026-12-01T23:59:00Z or 2026-12-01T23:59:00+01:00',
    ],
  ])('words the deadline problem for %s', (deadline, message) => {
    const result = validateFundingInput(
      'call',
      { ...validCall, deadline },
      { now: NOW },
    );
    expect(result).toEqual({
      ok: false,
      code: 'funding_details_required',
      message,
    });
  });

  it('accepts a Z deadline and a +01:00 deadline as the same instant', () => {
    const zulu = validateFundingInput(
      'call',
      { ...validCall, deadline: '2026-12-01T23:59:00Z' },
      { now: NOW },
    );
    const offset = validateFundingInput(
      'call',
      { ...validCall, deadline: '2026-12-02T00:59:00+01:00' },
      { now: NOW },
    );
    expect(zulu.ok && zulu.value.deadline).toEqual(
      new Date('2026-12-01T23:59:00.000Z'),
    );
    expect(offset.ok && offset.value.deadline).toEqual(
      new Date('2026-12-01T23:59:00.000Z'),
    );
  });

  it('lets an edit keep a stored deadline that has already passed', () => {
    const stored = new Date('2026-10-01T00:00:00.000Z');
    const result = validateFundingInput(
      'call',
      { ...validCall, deadline: stored.toISOString() },
      { now: NOW, previousDeadline: stored },
    );
    expect(result.ok).toBe(true);
  });

  it('holds a moved deadline to the future', () => {
    const result = validateFundingInput(
      'call',
      { ...validCall, deadline: '2026-10-02T00:00:00.000Z' },
      { now: NOW, previousDeadline: new Date('2026-10-01T00:00:00.000Z') },
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'funding_details_required' }),
    );
  });

  it('refuses an http link with funding_link_invalid', () => {
    const result = validateFundingInput(
      'call',
      { ...validCall, linkUrl: 'http://www.gulbenkian.pt/bolsas' },
      { now: NOW },
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'funding_link_invalid' }),
    );
  });
});

describe('validateFundingInput: asks', () => {
  const validAsk = {
    linkUrl: 'https://www.gofundme.com/f/help-ana',
    goalAmount: 1200,
    askPurpose: 'healthcare',
    beneficiary: 'self',
    endsAt: '2026-12-31T23:00:00.000Z',
    funderName: 'ignored on an ask',
    eligibility: ['students'],
  };

  it('resolves a complete ask and drops the fields that belong to calls', () => {
    expect(validateFundingInput('ask', validAsk, { now: NOW })).toEqual({
      ok: true,
      value: {
        kind: 'ask',
        linkUrl: 'https://www.gofundme.com/f/help-ana',
        linkHost: 'gofundme.com',
        linkKey: 'gofundme.com/f/help-ana',
        funderName: null,
        amountMin: null,
        amountMax: null,
        deadline: null,
        eligibility: [],
        scope: null,
        goalAmount: 1200,
        askPurpose: 'healthcare',
        beneficiary: 'self',
        endsAt: new Date('2026-12-31T23:00:00.000Z'),
      },
    });
  });

  it('refuses a host off the allow-list', () => {
    const result = validateFundingInput(
      'ask',
      { ...validAsk, linkUrl: 'https://gofundme.com.evil.io/f/help-ana' },
      { now: NOW },
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'funding_link_host_not_allowed',
      }),
    );
  });

  it('refuses an explicit port on an ask link', () => {
    const result = validateFundingInput(
      'ask',
      { ...validAsk, linkUrl: 'https://gofundme.com:8443/f/help-ana' },
      { now: NOW },
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'funding_link_host_not_allowed',
      }),
    );
  });

  it('words an end date problem with the endsAt field name', () => {
    const result = validateFundingInput(
      'ask',
      { ...validAsk, endsAt: '2026-12-31T23:00' },
      { now: NOW },
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        message: 'endsAt needs a time zone, like 2026-12-01T23:59:00Z',
      }),
    );
  });

  it.each([
    ['a zero goal', { goalAmount: 0 }],
    ['no goal', { goalAmount: undefined }],
    ['an unknown purpose', { askPurpose: 'holiday' }],
    ['no beneficiary', { beneficiary: undefined }],
    ['an end date in the past', { endsAt: '2026-10-01T00:00:00.000Z' }],
    ['an end date two years out', { endsAt: '2028-10-05T09:00:00.000Z' }],
    ['an end date with no time zone', { endsAt: '2026-12-31T23:00' }],
    ['a date-only end date', { endsAt: '2026-12-31' }],
  ])('reports %s as funding_details_required', (_label, override) => {
    const result = validateFundingInput(
      'ask',
      { ...validAsk, ...override },
      { now: NOW },
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'funding_details_required' }),
    );
  });
});

describe('deriveCallState', () => {
  const updatedAt = new Date('2026-10-01T00:00:00.000Z');

  it('reads a deadline more than a week ahead as open', () => {
    expect(
      deriveCallState(new Date(NOW.getTime() + 8 * DAY_MS), updatedAt, NOW),
    ).toBe('open');
  });

  it('reads a deadline within seven days as closing', () => {
    expect(
      deriveCallState(new Date(NOW.getTime() + 7 * DAY_MS), updatedAt, NOW),
    ).toBe('closing');
  });

  it('reads a passed deadline as closed', () => {
    expect(deriveCallState(new Date(NOW.getTime() - 1), updatedAt, NOW)).toBe(
      'closed',
    );
  });

  it('reads a recently edited rolling call as open', () => {
    expect(deriveCallState(null, updatedAt, NOW)).toBe('open');
  });

  it('reads a rolling call untouched for more than 183 days as stale', () => {
    expect(
      deriveCallState(null, new Date(NOW.getTime() - 184 * DAY_MS), NOW),
    ).toBe('stale');
  });
});

describe('deriveAskState', () => {
  const approved = {
    reviewState: 'approved',
    hasAuthor: true,
    endedAt: null,
    endsAt: null,
    approvedAt: new Date(NOW.getTime() - DAY_MS),
  };

  it('is active once approved', () => {
    expect(deriveAskState(approved, NOW)).toBe('active');
  });

  it.each(['pending', 'rejected', null])(
    'is pending while the review state is %s',
    (reviewState) => {
      expect(
        deriveAskState({ ...approved, reviewState, approvedAt: null }, NOW),
      ).toBe('pending');
    },
  );

  it('is ended when the author ended it, even while pending', () => {
    expect(
      deriveAskState(
        { ...approved, reviewState: 'pending', endedAt: NOW },
        NOW,
      ),
    ).toBe('ended');
  });

  it('is ended once endsAt has passed', () => {
    expect(
      deriveAskState({ ...approved, endsAt: new Date(NOW.getTime() - 1) }, NOW),
    ).toBe('ended');
  });

  it('stays active until endsAt even beyond 90 days', () => {
    expect(
      deriveAskState(
        {
          ...approved,
          approvedAt: new Date(NOW.getTime() - 100 * DAY_MS),
          endsAt: new Date(NOW.getTime() + DAY_MS),
        },
        NOW,
      ),
    ).toBe('active');
  });

  it('ends 90 days after approval when no end date was set', () => {
    expect(
      deriveAskState(
        {
          ...approved,
          approvedAt: new Date(NOW.getTime() - ASK_AUTO_END_MS - 1),
        },
        NOW,
      ),
    ).toBe('ended');
  });

  it('is ended once the author erased their account', () => {
    expect(deriveAskState({ ...approved, hasAuthor: false }, NOW)).toBe(
      'ended',
    );
  });
});

describe('withServerOwnedFundingTag', () => {
  it('puts open-call first on a call and keeps the member tags that still fit', () => {
    expect(
      withServerOwnedFundingTag(
        'call',
        ['grants', 'fund', 'arts', 'lisbon', 'film'],
        5,
      ),
    ).toEqual([OPEN_CALL_TAG, 'grants', 'fund', 'arts', 'lisbon']);
  });

  it('keeps a single open-call when the member already typed it', () => {
    expect(
      withServerOwnedFundingTag('call', ['open-call', 'grants'], 5),
    ).toEqual([OPEN_CALL_TAG, 'grants']);
  });

  it.each(['question', 'ask', null])(
    'strips open-call from a %s thread',
    (kind) => {
      expect(
        withServerOwnedFundingTag(kind, ['open-call', 'grants'], 5),
      ).toEqual(['grants']);
    },
  );
});

describe('small predicates', () => {
  it('recognises the two funding kinds', () => {
    expect(isFundingKind('call')).toBe(true);
    expect(isFundingKind('ask')).toBe(true);
    expect(isFundingKind('question')).toBe(false);
    expect(isFundingKind(null)).toBe(false);
  });

  it('matches the stored funding category exactly', () => {
    expect(isFundingCategory('funding')).toBe(true);
    expect(isFundingCategory(' Funding ')).toBe(false);
    expect(isFundingCategory('FUNDING')).toBe(false);
    expect(isFundingCategory('activism')).toBe(false);
  });

  it('strips one leading www. from a host and nothing else', () => {
    expect(stripLeadingWww('www.gofundme.com')).toBe('gofundme.com');
    expect(stripLeadingWww('www.www.gofundme.com')).toBe('www.gofundme.com');
    expect(stripLeadingWww('wwwgofundme.com')).toBe('wwwgofundme.com');
  });

  it('notices a deadline moving, appearing or going rolling', () => {
    const first = new Date('2026-11-01T00:00:00.000Z');
    expect(hasDeadlineChanged(first, new Date(first.getTime()))).toBe(false);
    expect(
      hasDeadlineChanged(first, new Date('2026-11-08T00:00:00.000Z')),
    ).toBe(true);
    expect(hasDeadlineChanged(null, first)).toBe(true);
    expect(hasDeadlineChanged(first, null)).toBe(true);
    expect(hasDeadlineChanged(null, null)).toBe(false);
  });
});

describe('fundingException', () => {
  it.each([
    ['funding_link_invalid', 400, 'Bad Request'],
    ['funding_ask_verification_required', 403, 'Forbidden'],
    ['funding_ask_limit_reached', 409, 'Conflict'],
  ] as const)('builds %s with the pledge body shape', (code, status, error) => {
    const exception = fundingException(code);
    expect(exception).toBeInstanceOf(HttpException);
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toEqual({
      statusCode: status,
      error,
      message: expect.any(String),
      code,
    });
  });

  it('carries a caller message', () => {
    expect(
      fundingException(
        'funding_details_required',
        'scope is required for an open call',
      ).getResponse(),
    ).toEqual(
      expect.objectContaining({
        message: 'scope is required for an open call',
      }),
    );
  });
});
