import {
  compareNewestFirst,
  decodePlatformLogCursor,
  encodePlatformLogCursor,
} from './platform-log-cursor';

describe('platform log cursor', () => {
  const key = {
    occurredAtExact: '2026-10-05T12:00:00.123456Z',
    sourceKey: 'vouch',
    rowId: '5b0c3a52-1d7e-4f43-9a35-2f6d0b7e1a01',
  };

  it('round-trips a key', () => {
    expect(decodePlatformLogCursor(encodePlatformLogCursor(key))).toEqual(key);
  });

  it('reads a missing or garbage cursor as the first page', () => {
    expect(decodePlatformLogCursor(undefined)).toBeNull();
    expect(decodePlatformLogCursor('')).toBeNull();
    expect(decodePlatformLogCursor('not-base64-%%%')).toBeNull();
  });

  it('rejects the legacy two-part cursor and millisecond timestamps', () => {
    const legacy = Buffer.from(
      '2026-10-05T12:00:00.123Z|5b0c3a52-1d7e-4f43-9a35-2f6d0b7e1a01',
    ).toString('base64');
    const milliseconds = Buffer.from(
      '2026-10-05T12:00:00.123Z|vouch|abc',
    ).toString('base64');
    expect(decodePlatformLogCursor(legacy)).toBeNull();
    expect(decodePlatformLogCursor(milliseconds)).toBeNull();
  });

  it('orders newest first, then by source key and row id descending', () => {
    const older = { ...key, occurredAtExact: '2026-10-05T11:59:59.999999Z' };
    const sameTimeLowerSource = { ...key, sourceKey: 'mod' };
    const sameSourceLowerRow = { ...key, rowId: '0000' };
    const sorted = [older, sameSourceLowerRow, sameTimeLowerSource, key].sort(
      compareNewestFirst,
    );
    expect(sorted).toEqual([
      key,
      sameSourceLowerRow,
      sameTimeLowerSource,
      older,
    ]);
  });
});
