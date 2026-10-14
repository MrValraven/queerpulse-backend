import {
  decodePersonaPostCursor,
  encodePersonaPostCursor,
} from './persona-post-cursor';

const POST_ID = 'dc000000-0000-4000-8000-000000000001';

describe('persona post cursor', () => {
  it('round-trips the last post of a page', () => {
    const cursor = {
      createdAt: new Date('2026-10-13T09:00:00.123Z'),
      id: POST_ID,
    };
    expect(decodePersonaPostCursor(encodePersonaPostCursor(cursor))).toEqual(
      cursor,
    );
  });

  it.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['garbage', 'not-base64-at-all'],
    ['a bad date', Buffer.from(`soon|${POST_ID}`).toString('base64url')],
    [
      'a bad id',
      Buffer.from('2026-10-13T09:00:00.000Z|x').toString('base64url'),
    ],
  ])('reads %s as the first page', (_label, cursor) => {
    expect(decodePersonaPostCursor(cursor)).toBeNull();
  });
});
