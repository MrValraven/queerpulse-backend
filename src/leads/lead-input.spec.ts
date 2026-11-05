import { HttpException } from '@nestjs/common';
import { encodeLeadCursor } from './lead-cursor';
import {
  isLeadFollowUpDue,
  isLeadStage,
  isLeadType,
  isOpenLeadStage,
  normalizeLeadCreate,
  normalizeLeadLinks,
  normalizeLeadListFilters,
  normalizeLeadUpdate,
  normalizeNoteBody,
  sanitizeLeadText,
} from './lead-input';

const PERSONA_ID = '3b9d6c1e-2f4a-4c8b-9d7e-5a6b7c8d9e0f';
const LEAD_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';

interface RefusalOutcome {
  code?: string;
  status?: number;
  index?: number;
}

function codeOf(run: () => unknown): RefusalOutcome {
  try {
    run();
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as { code?: string; index?: number };
    const outcome: RefusalOutcome = {
      code: body.code,
      status: httpError.getStatus(),
    };
    if (body.index !== undefined) outcome.index = body.index;
    return outcome;
  }
}

function createCodeOf(body: Record<string, unknown>): string | undefined {
  return codeOf(() => normalizeLeadCreate(body)).code;
}

function updateCodeOf(body: Record<string, unknown>): RefusalOutcome {
  return codeOf(() => normalizeLeadUpdate(body));
}

function listCodeOf(query: Record<string, unknown>): string | undefined {
  return codeOf(() => normalizeLeadListFilters(query)).code;
}

function distinctLinks(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, linkIndex) => `https://example.org/page-${linkIndex}`,
  );
}

const NAMED = { name: 'Ana' };
const TYPED = { ...NAMED, type: 'dj' };

describe('normalizeLeadCreate', () => {
  it.each([
    ['an empty body', {}, 'LEAD_NAME_REQUIRED'],
    ['a blank name', { name: '   ' }, 'LEAD_NAME_REQUIRED'],
    ['a number as name', { name: 5 }, 'LEAD_NAME_REQUIRED'],
    ['a 121 character name', { name: 'a'.repeat(121) }, 'LEAD_NAME_TOO_LONG'],
    ['no type', NAMED, 'LEAD_TYPE_INVALID'],
    ['an unknown type', { ...NAMED, type: 'singer' }, 'LEAD_TYPE_INVALID'],
    ['a null stage', { ...TYPED, stage: null }, 'LEAD_STAGE_INVALID'],
    [
      'a number as location',
      { ...TYPED, location: 7 },
      'LEAD_LOCATION_TOO_LONG',
    ],
    [
      'a 121 character location',
      { ...TYPED, location: 'l'.repeat(121) },
      'LEAD_LOCATION_TOO_LONG',
    ],
    ['a malformed email', { ...TYPED, email: 'ana@' }, 'LEAD_EMAIL_INVALID'],
    ['an object as email', { ...TYPED, email: {} }, 'LEAD_EMAIL_INVALID'],
    [
      'a 41 character phone',
      { ...TYPED, phone: 'x'.repeat(41) },
      'LEAD_PHONE_TOO_LONG',
    ],
    ['a text as links', { ...TYPED, links: 'x' }, 'LEAD_LINK_INVALID'],
    [
      'a day that does not exist',
      { ...TYPED, followUpOn: '2026-02-30' },
      'LEAD_FOLLOW_UP_INVALID',
    ],
    [
      'a day before the range',
      { ...TYPED, followUpOn: '1999-12-31' },
      'LEAD_FOLLOW_UP_INVALID',
    ],
    [
      'a day after the range',
      { ...TYPED, followUpOn: '2101-01-01' },
      'LEAD_FOLLOW_UP_INVALID',
    ],
    ['a number as note', { ...TYPED, note: 5 }, 'LEAD_NOTE_EMPTY'],
    [
      'a 4001 character note',
      { ...TYPED, note: 'x'.repeat(4001) },
      'LEAD_NOTE_TOO_LONG',
    ],
  ])('checks create fields in the contract order: %s', (_label, body, code) => {
    expect(createCodeOf(body)).toBe(code);
  });

  it('counts the name in code points', () => {
    expect(
      normalizeLeadCreate({ name: '🌈'.repeat(120), type: 'dj' }).name,
    ).toBe('🌈'.repeat(120));
  });

  it('answers links that are no array with index -1', () => {
    expect(codeOf(() => normalizeLeadCreate({ ...TYPED, links: 'x' }))).toEqual(
      { code: 'LEAD_LINK_INVALID', status: 400, index: -1 },
    );
    expect(
      codeOf(() => normalizeLeadCreate({ ...TYPED, links: null })),
    ).toEqual({ code: 'LEAD_LINK_INVALID', status: 400, index: -1 });
  });

  it.each([
    [
      'a bad location and a bad email',
      { ...TYPED, location: 7, email: 'ana@' },
      'LEAD_LOCATION_TOO_LONG',
    ],
    [
      'a bad email and a bad phone',
      { ...TYPED, email: 'ana@', phone: 'x'.repeat(41) },
      'LEAD_EMAIL_INVALID',
    ],
    [
      'a bad phone and bad links',
      { ...TYPED, phone: 1, links: 'x' },
      'LEAD_PHONE_TOO_LONG',
    ],
    [
      'bad links and a bad follow-up day',
      { ...TYPED, links: ['nope'], followUpOn: '2026-02-30' },
      'LEAD_LINK_INVALID',
    ],
    [
      'a bad follow-up day and a bad first note',
      { ...TYPED, followUpOn: '1999-12-31', note: 5 },
      'LEAD_FOLLOW_UP_INVALID',
    ],
    [
      'a bad type and a bad stage',
      { ...NAMED, type: 'singer', stage: 'done' },
      'LEAD_TYPE_INVALID',
    ],
    [
      'a bad stage and a bad location',
      { ...TYPED, stage: null, location: 7 },
      'LEAD_STAGE_INVALID',
    ],
  ])(
    'answers the earlier code when two fields break: %s',
    (_label, body, code) => {
      expect(createCodeOf(body)).toBe(code);
    },
  );

  it('trims a padded type, stage and follow-up day before their checks', () => {
    const lead = normalizeLeadCreate({
      name: 'Ana',
      type: 'band ',
      stage: '  in_talks ',
      followUpOn: ' 2026-11-05 ',
    });
    expect(lead.type).toBe('band');
    expect(lead.stage).toBe('in_talks');
    expect(lead.followUpOn).toBe('2026-11-05');
  });

  it('stores a name without a NUL', () => {
    expect(
      normalizeLeadCreate({ name: 'An\u0000a\u0000', type: 'dj' }).name,
    ).toBe('Ana');
    expect(createCodeOf({ name: '\u0000 \u0000', type: 'dj' })).toBe(
      'LEAD_NAME_REQUIRED',
    );
  });

  it('removes a NUL from location, email, phone and the first note', () => {
    const lead = normalizeLeadCreate({
      ...TYPED,
      location: 'Lis\u0000bon',
      email: 'ana@x.pt\u0000',
      phone: '+351\u0000 900',
      note: 'hi\u0000 there',
    });
    expect(lead.location).toBe('Lisbon');
    expect(lead.email).toBe('ana@x.pt');
    expect(lead.phone).toBe('+351 900');
    expect(lead.note).toBe('hi there');
    expect(normalizeLeadCreate({ ...TYPED, note: '\u0000' }).note).toBeNull();
  });

  it('answers the name code first when every field is wrong', () => {
    expect(createCodeOf({ name: 5, type: 'nope', links: 'x', note: 5 })).toBe(
      'LEAD_NAME_REQUIRED',
    );
  });

  it('normalises a valid create', () => {
    expect(
      normalizeLeadCreate({
        name: ' Ana ',
        type: 'dj',
        email: ' Ana@X.PT ',
        location: '',
        phone: '  ',
        note: '  hi\nthere ',
      }),
    ).toEqual({
      name: 'Ana',
      type: 'dj',
      stage: 'to_contact',
      location: null,
      email: 'ana@x.pt',
      phone: null,
      links: [],
      followUpOn: null,
      note: 'hi\nthere',
    });
    expect(normalizeLeadCreate({ ...TYPED, note: '   ' }).note).toBeNull();
    expect(normalizeLeadCreate({ ...TYPED, note: null }).note).toBeNull();
  });

  it('keeps a sent stage and a real follow-up day', () => {
    const lead = normalizeLeadCreate({
      ...TYPED,
      stage: 'contacted',
      followUpOn: '2028-02-29',
    });
    expect(lead.stage).toBe('contacted');
    expect(lead.followUpOn).toBe('2028-02-29');
  });
});

describe('normalizeLeadLinks', () => {
  it('checks links entry by entry with the submitted index', () => {
    expect(codeOf(() => normalizeLeadLinks(['https://a.org', 5]))).toEqual({
      code: 'LEAD_LINK_INVALID',
      status: 400,
      index: 1,
    });
    expect(codeOf(() => normalizeLeadLinks(['', 'nope']))).toEqual({
      code: 'LEAD_LINK_INVALID',
      status: 400,
      index: 1,
    });
    expect(
      codeOf(() => normalizeLeadLinks(['https://a.org/' + 'x'.repeat(500)])),
    ).toEqual({ code: 'LEAD_LINK_TOO_LONG', status: 400, index: 0 });
    expect(
      normalizeLeadLinks([
        ' https://instagram.com/ana/ ',
        'http://www.instagram.com/ana?x=1',
        '  ',
      ]),
    ).toEqual([
      {
        text: 'https://instagram.com/ana/',
        key: 'instagram.com/ana',
        submittedIndex: 0,
      },
    ]);
  });

  it('stores and keys a link without a NUL or a lone surrogate', () => {
    const [nulLink] = normalizeLeadLinks(['https://a.org/press\u0000']);
    expect(nulLink).toEqual({
      text: 'https://a.org/press',
      key: 'a.org/press',
      submittedIndex: 0,
    });
    const [surrogateLink] = normalizeLeadLinks(['https://a.org/x\uD800']);
    expect(surrogateLink?.text).toBe('https://a.org/x\uFFFD');
    expect(surrogateLink?.text).not.toMatch(/[\uD800-\uDFFF]/);
    expect(surrogateLink?.key).not.toMatch(/[\uD800-\uDFFF]/);
    expect(surrogateLink?.key).toBe('a.org/x%EF%BF%BD');
    expect(nulLink?.key).not.toContain('\u0000');
    expect(normalizeLeadLinks(['\u0000', ' '])).toEqual([]);
  });

  it('counts links after blanks and duplicates drop', () => {
    expect(codeOf(() => normalizeLeadLinks(distinctLinks(13)))).toEqual({
      code: 'LEAD_TOO_MANY_LINKS',
      status: 400,
    });
    const withDuplicate = [
      ...distinctLinks(12),
      'https://www.example.org/page-0',
    ];
    expect(normalizeLeadLinks(withDuplicate)).toHaveLength(12);
    expect(normalizeLeadLinks([...distinctLinks(12), '', '  '])).toHaveLength(
      12,
    );
  });

  it('refuses an invalid entry that comes after twelve good ones by its own index', () => {
    expect(
      codeOf(() => normalizeLeadLinks([...distinctLinks(12), 'ftp://x.org'])),
    ).toEqual({ code: 'LEAD_LINK_INVALID', status: 400, index: 12 });
  });
});

describe('normalizeLeadUpdate', () => {
  it('leaves absent update fields out and maps null and blank', () => {
    expect(normalizeLeadUpdate({})).toEqual({});
    expect(updateCodeOf({ name: null }).code).toBe('LEAD_NAME_REQUIRED');
    expect(updateCodeOf({ type: null }).code).toBe('LEAD_TYPE_INVALID');
    expect(updateCodeOf({ stage: null }).code).toBe('LEAD_STAGE_INVALID');
    expect(
      normalizeLeadUpdate({
        location: '',
        email: null,
        phone: '  ',
        followUpOn: null,
        linkedSubprofileId: null,
      }),
    ).toEqual({
      location: null,
      email: null,
      phone: null,
      followUpOn: null,
      linkedSubprofileId: null,
    });
  });

  it('keeps only the sent fields, normalised', () => {
    expect(
      normalizeLeadUpdate({
        stage: 'on_board',
        links: ['https://a.org/x/'],
        linkedSubprofileId: PERSONA_ID.toUpperCase(),
      }),
    ).toEqual({
      stage: 'on_board',
      links: [{ text: 'https://a.org/x/', key: 'a.org/x', submittedIndex: 0 }],
      linkedSubprofileId: PERSONA_ID,
    });
  });

  it('trims a padded stage, follow-up day and persona id', () => {
    expect(
      normalizeLeadUpdate({
        stage: ' contacted ',
        followUpOn: '2026-11-05 ',
        linkedSubprofileId: ` ${PERSONA_ID} `,
      }),
    ).toEqual({
      stage: 'contacted',
      followUpOn: '2026-11-05',
      linkedSubprofileId: PERSONA_ID,
    });
  });

  it('answers 400 LEAD_PERSONA_NOT_FOUND for a malformed persona id after the field checks', () => {
    expect(updateCodeOf({ linkedSubprofileId: 'nope' })).toEqual({
      code: 'LEAD_PERSONA_NOT_FOUND',
      status: 400,
    });
    expect(updateCodeOf({ linkedSubprofileId: 5 })).toEqual({
      code: 'LEAD_PERSONA_NOT_FOUND',
      status: 400,
    });
    expect(updateCodeOf({ name: '', linkedSubprofileId: 'nope' }).code).toBe(
      'LEAD_NAME_REQUIRED',
    );
    expect(
      updateCodeOf({ followUpOn: '2026-02-30', linkedSubprofileId: 'nope' })
        .code,
    ).toBe('LEAD_FOLLOW_UP_INVALID');
  });
});

describe('normalizeNoteBody', () => {
  it('trims a note and keeps inner line breaks', () => {
    expect(normalizeNoteBody(' a\n\nb ')).toBe('a\n\nb');
  });

  it.each([
    ['an empty text', ''],
    ['a blank text', '  '],
    ['a number', 5],
    ['no value', undefined],
    ['an array', ['a']],
  ])('answers LEAD_NOTE_EMPTY for %s', (_label, value) => {
    expect(codeOf(() => normalizeNoteBody(value))).toEqual({
      code: 'LEAD_NOTE_EMPTY',
      status: 400,
    });
  });

  it('removes a NUL from a note body', () => {
    expect(normalizeNoteBody(' a\u0000\nb ')).toBe('a\nb');
    expect(codeOf(() => normalizeNoteBody('\u0000'))).toEqual({
      code: 'LEAD_NOTE_EMPTY',
      status: 400,
    });
  });

  it('counts the note in code points', () => {
    expect(codeOf(() => normalizeNoteBody('🌈'.repeat(4001)))).toEqual({
      code: 'LEAD_NOTE_TOO_LONG',
      status: 400,
    });
    expect(normalizeNoteBody('🌈'.repeat(4000))).toBe('🌈'.repeat(4000));
  });
});

describe('normalizeLeadListFilters', () => {
  it('checks list filters in the order stage, type, cursor', () => {
    expect(listCodeOf({ stage: 'x', type: 'y', cursor: 'bad' })).toBe(
      'LEAD_STAGE_INVALID',
    );
    expect(listCodeOf({ type: 'y', cursor: 'bad' })).toBe('LEAD_TYPE_INVALID');
    expect(listCodeOf({ cursor: 'bad' })).toBe('LEAD_CURSOR_INVALID');
    expect(listCodeOf({ stage: ['to_contact'] })).toBe('LEAD_STAGE_INVALID');
    expect(listCodeOf({ type: ['dj'] })).toBe('LEAD_TYPE_INVALID');
    expect(listCodeOf({ cursor: ['a'] })).toBe('LEAD_CURSOR_INVALID');
  });

  it('reads blank filters as none and due only as the text true', () => {
    expect(normalizeLeadListFilters({ q: '  ', stage: '', type: '' })).toEqual({
      term: '',
      stage: null,
      type: null,
      isDueOnly: false,
      cursor: null,
    });
    expect(normalizeLeadListFilters({ due: 'TRUE' }).isDueOnly).toBe(false);
    expect(normalizeLeadListFilters({ due: '1' }).isDueOnly).toBe(false);
    expect(normalizeLeadListFilters({ due: ['true'] }).isDueOnly).toBe(false);
    expect(normalizeLeadListFilters({ due: 'true' }).isDueOnly).toBe(true);
    expect(normalizeLeadListFilters({ q: ['a', 'b'] }).term).toBe('');
    expect(normalizeLeadListFilters({ q: '🌈'.repeat(150) }).term).toBe(
      '🌈'.repeat(100),
    );
  });

  it('removes a NUL from the search term and trims padded filters', () => {
    expect(
      normalizeLeadListFilters({
        q: ' an\u0000a ',
        stage: ' on_board ',
        type: 'venue ',
      }),
    ).toMatchObject({ term: 'ana', stage: 'on_board', type: 'venue' });
    expect(normalizeLeadListFilters({ q: '\u0000' }).term).toBe('');
    expect(normalizeLeadListFilters({ stage: '  ', type: ' ' })).toMatchObject({
      stage: null,
      type: null,
    });
  });

  it('keeps a valid stage, type, term and cursor', () => {
    const position = {
      today: '2026-11-05',
      dueRank: 1 as const,
      dueOn: null,
      updatedAt: '2026-11-05T10:00:00.123456Z',
      leadId: LEAD_ID,
    };
    expect(
      normalizeLeadListFilters({
        q: ' ana ',
        stage: 'in_talks',
        type: 'venue',
        cursor: encodeLeadCursor(position),
      }),
    ).toEqual({
      term: 'ana',
      stage: 'in_talks',
      type: 'venue',
      isDueOnly: false,
      cursor: position,
    });
  });
});

describe('sanitizeLeadText', () => {
  it('removes every NUL and replaces each lone surrogate', () => {
    expect(sanitizeLeadText('a\u0000b\u0000')).toBe('ab');
    expect(sanitizeLeadText('x\uD800y')).toBe('x\uFFFDy');
    expect(sanitizeLeadText('x\uDC00y')).toBe('x\uFFFDy');
    expect(sanitizeLeadText('\uDC00\uD800')).toBe('\uFFFD\uFFFD');
  });

  it('keeps paired surrogates and is idempotent', () => {
    expect(sanitizeLeadText('🌈 ok')).toBe('🌈 ok');
    const once = sanitizeLeadText('a\u0000\uD800🌈\uDC00');
    expect(sanitizeLeadText(once)).toBe(once);
  });
});

describe('lead guards', () => {
  it('recognise the contract values only', () => {
    expect(isLeadType('collective')).toBe(true);
    expect(isLeadType('DJ')).toBe(false);
    expect(isLeadType(5)).toBe(false);
    expect(isLeadStage('not_now')).toBe(true);
    expect(isLeadStage('done')).toBe(false);
    expect(isOpenLeadStage('in_talks')).toBe(true);
    expect(isOpenLeadStage('on_board')).toBe(false);
  });
});

describe('isLeadFollowUpDue', () => {
  it('is due only in an open stage on or before today', () => {
    expect(isLeadFollowUpDue('contacted', '2026-11-05', '2026-11-05')).toBe(
      true,
    );
    expect(isLeadFollowUpDue('to_contact', '2026-11-01', '2026-11-05')).toBe(
      true,
    );
    expect(isLeadFollowUpDue('contacted', '2026-11-06', '2026-11-05')).toBe(
      false,
    );
    expect(isLeadFollowUpDue('contacted', null, '2026-11-05')).toBe(false);
    expect(isLeadFollowUpDue('on_board', '2026-11-01', '2026-11-05')).toBe(
      false,
    );
    expect(isLeadFollowUpDue('not_now', '2026-11-01', '2026-11-05')).toBe(
      false,
    );
  });
});
