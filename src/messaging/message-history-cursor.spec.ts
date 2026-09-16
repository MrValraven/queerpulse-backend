import { encodeCursor } from '../common/cursor-pagination';
import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
} from './message-history-cursor';

const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';

function rawCursor(text: string): string {
  return Buffer.from(text).toString('base64');
}

describe('message history cursor', () => {
  it('round-trips a six-digit microsecond timestamp verbatim', () => {
    const cursor = encodeMessageHistoryCursor(
      '2026-01-01T00:00:00.123456Z',
      MESSAGE_ID,
    );

    expect(decodeMessageHistoryCursor(cursor)).toEqual({
      before: '2026-01-01T00:00:00.123456Z',
      beforeId: MESSAGE_ID,
    });
  });

  it('round-trips a timestamp with no fractional seconds', () => {
    const cursor = encodeMessageHistoryCursor(
      '2026-01-01T00:00:00Z',
      MESSAGE_ID,
    );

    expect(decodeMessageHistoryCursor(cursor)).toEqual({
      before: '2026-01-01T00:00:00Z',
      beforeId: MESSAGE_ID,
    });
  });

  it('still decodes the millisecond form the shared codec emits', () => {
    const cursor = encodeCursor({
      createdAt: new Date('2026-01-01T00:00:00.123Z'),
      id: MESSAGE_ID,
    });

    expect(decodeMessageHistoryCursor(cursor)).toEqual({
      before: '2026-01-01T00:00:00.123Z',
      beforeId: MESSAGE_ID,
    });
  });

  // Every rejected value would otherwise reach a `::timestamptz` or `::uuid`
  // cast in SQL, so each must resolve to null (first page) instead of a 500.
  it.each([
    [
      '24:00:00, which JS rolls into the next day',
      `2026-01-01T24:00:00Z|${MESSAGE_ID}`,
    ],
    ['year 0000, which Postgres rejects', `0000-01-01T00:00:00Z|${MESSAGE_ID}`],
    ['an impossible calendar date', `2026-02-30T00:00:00Z|${MESSAGE_ID}`],
    ['a missing separator', `2026-01-01T00:00:00Z${MESSAGE_ID}`],
    ['a non-uuid id', '2026-01-01T00:00:00Z|not-a-uuid'],
    ['a timestamp without a UTC zone', `2026-01-01T00:00:00|${MESSAGE_ID}`],
  ])('rejects %s', (_label, text) => {
    expect(decodeMessageHistoryCursor(rawCursor(text))).toBeNull();
  });

  it('rejects input that is not base64 at all', () => {
    expect(decodeMessageHistoryCursor('%%% not base64 %%%')).toBeNull();
    expect(decodeMessageHistoryCursor('')).toBeNull();
  });
});
