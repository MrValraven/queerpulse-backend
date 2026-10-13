import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';

const RELEASE_ID = '8a000000-0000-4000-8000-000000000001';

describe('Studio release cursor', () => {
  it('round-trips the published time and id', () => {
    const publishedAt = new Date('2026-10-08T12:34:56.789Z');
    expect(
      decodeStudioCursor(encodeStudioCursor({ publishedAt, id: RELEASE_ID })),
    ).toEqual({ publishedAt, id: RELEASE_ID });
  });

  it.each([
    undefined,
    '',
    'not a cursor',
    Buffer.from('2026-10-08T00:00:00.000Z', 'utf8').toString('base64url'),
    Buffer.from(`yesterday|${RELEASE_ID}`, 'utf8').toString('base64url'),
    Buffer.from('2026-10-08T00:00:00.000Z|release-1', 'utf8').toString(
      'base64url',
    ),
  ])('reads %p as the first page', (cursor) => {
    expect(decodeStudioCursor(cursor)).toBeNull();
  });
});
