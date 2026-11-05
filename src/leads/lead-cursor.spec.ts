import { HttpException } from '@nestjs/common';
import {
  decodeLeadCursor,
  encodeLeadCursor,
  isRealCalendarDay,
  LEAD_CURSOR_MAX_LENGTH,
  type LeadCursorPosition,
} from './lead-cursor';

const LEAD_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';
const UPDATED_AT = '2026-11-05T10:00:00.123456Z';

interface RefusalOutcome {
  code?: string;
  status?: number;
}

function codeOf(run: () => unknown): RefusalOutcome {
  try {
    run();
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as { code?: string };
    return { code: body.code, status: httpError.getStatus() };
  }
}

/** Encodes raw cursor text the way `encodeLeadCursor` does. */
function rawCursor(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function cursorParts(parts: string[]): string {
  return rawCursor(parts.join('|'));
}

const VALID_PARTS = [
  'v1',
  '2026-11-05',
  '0',
  '2026-11-01',
  UPDATED_AT,
  LEAD_ID,
];

function partsWith(index: number, value: string): string[] {
  const parts = [...VALID_PARTS];
  parts[index] = value;
  return parts;
}

describe('lead cursor', () => {
  it('round trips a due position and a later position', () => {
    const duePosition: LeadCursorPosition = {
      today: '2026-11-05',
      dueRank: 0,
      dueOn: '2026-11-01',
      updatedAt: UPDATED_AT,
      leadId: LEAD_ID,
    };
    const laterPosition: LeadCursorPosition = {
      ...duePosition,
      dueRank: 1,
      dueOn: null,
    };
    expect(decodeLeadCursor(encodeLeadCursor(duePosition))).toEqual(
      duePosition,
    );
    expect(decodeLeadCursor(encodeLeadCursor(laterPosition))).toEqual(
      laterPosition,
    );
    const laterText = Buffer.from(
      encodeLeadCursor(laterPosition),
      'base64url',
    ).toString('utf8');
    expect(laterText).toContain('|-|');
    expect(laterText).toBe(`v1|2026-11-05|1|-|${UPDATED_AT}|${LEAD_ID}`);
  });

  it('keeps a real cursor well under the length bound', () => {
    const cursor = encodeLeadCursor({
      today: '2026-11-05',
      dueRank: 0,
      dueOn: '2026-11-01',
      updatedAt: UPDATED_AT,
      leadId: LEAD_ID,
    });
    expect(cursor.length).toBeLessThan(LEAD_CURSOR_MAX_LENGTH);
  });

  it.each([
    ['a cursor over 200 characters', 'a'.repeat(201)],
    ['a v2 prefix', cursorParts(partsWith(0, 'v2'))],
    ['five parts', cursorParts(VALID_PARTS.slice(0, 5))],
    ['seven parts', cursorParts([...VALID_PARTS, 'extra'])],
    ['2026-02-30 as today', cursorParts(partsWith(1, '2026-02-30'))],
    ['2 as rank', cursorParts(partsWith(2, '2'))],
    ['rank 1 with a day', cursorParts(partsWith(2, '1'))],
    ['rank 0 with -', cursorParts(partsWith(3, '-'))],
    [
      'a timestamp with three fractional digits',
      cursorParts(partsWith(4, '2026-11-05T10:00:00.123Z')),
    ],
    [
      'hour 24 in the timestamp',
      cursorParts(partsWith(4, '2026-11-05T24:00:00.000000Z')),
    ],
    ['nope as id', cursorParts(partsWith(5, 'nope'))],
    [
      'random text that decodes to no v1 cursor',
      'qwertyuiop-asdfghjkl_zxcvbnm',
    ],
    ['an empty cursor', ''],
  ])('answers 400 LEAD_CURSOR_INVALID for %s', (_label, cursor) => {
    expect(codeOf(() => decodeLeadCursor(cursor))).toEqual({
      code: 'LEAD_CURSOR_INVALID',
      status: 400,
    });
  });

  it('checks real calendar days', () => {
    expect(isRealCalendarDay('2028-02-29')).toBe(true);
    expect(isRealCalendarDay('2026-11-05')).toBe(true);
    expect(isRealCalendarDay('2026-02-29')).toBe(false);
    expect(isRealCalendarDay('2026-13-01')).toBe(false);
    expect(isRealCalendarDay('2026-1-01')).toBe(false);
    expect(isRealCalendarDay('20260101')).toBe(false);
    expect(isRealCalendarDay('0000-01-01')).toBe(false);
    expect(isRealCalendarDay('')).toBe(false);
  });
});
