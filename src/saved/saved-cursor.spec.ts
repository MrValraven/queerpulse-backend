import { SavedItem, SavedKind } from './entities/saved-item.entity';
import {
  SAVED_AFTER_CURSOR_SQL,
  decodeSavedCursor,
  encodeSavedCursor,
  savedCursorParameters,
} from './saved-cursor';

const savedAt = new Date('2026-10-21T09:30:00.123Z');

const savedRow = (subjectId: string): SavedItem => ({
  id: 'b2000000-0000-4000-8000-000000000001',
  userId: 'u1',
  subjectType: SavedKind.StudioRelease,
  subjectId,
  title: 'Lisbon at four',
  href: null,
  meta: null,
  description: null,
  readTime: null,
  createdAt: savedAt,
});

const encodeText = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64url');

describe('saved cursor (ENG-04)', () => {
  it('round-trips the save time and the composite ref', () => {
    expect(
      decodeSavedCursor(encodeSavedCursor(savedRow('c1000000-0000'))),
    ).toEqual({
      savedAt,
      ref: { subjectType: SavedKind.StudioRelease, subjectId: 'c1000000-0000' },
    });
  });

  it('keeps a subject id that holds a bar or a colon', () => {
    const decoded = decodeSavedCursor(encodeSavedCursor(savedRow('a|b:c')));
    expect(decoded?.ref.subjectId).toBe('a|b:c');
  });

  it('never carries the row id', () => {
    const decodedText = Buffer.from(
      encodeSavedCursor(savedRow('subject-1')),
      'base64url',
    ).toString('utf8');
    expect(decodedText).not.toContain('b2000000');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['without a separator', encodeText('2026-10-21T09:30:00.123Z')],
    ['with a bad time', encodeText('yesterday|studio_release:x')],
    ['in year 0000', encodeText('0000-01-01T00:00:00.000Z|studio_release:x')],
    [
      'with an extended year',
      encodeText('+010000-01-01T00:00:00.000Z|studio_release:x'),
    ],
    [
      'with a negative year',
      encodeText('-000001-01-01T00:00:00.000Z|studio_release:x'),
    ],
    ['with an unknown kind', encodeText('2026-10-21T09:30:00.123Z|nope:x')],
    ['with no subject', encodeText('2026-10-21T09:30:00.123Z|studio_release:')],
  ])('reads a cursor %s as the first page', (_label, cursor) => {
    expect(decodeSavedCursor(cursor)).toBeNull();
  });

  it('binds the ref and the time, and reuses the caller scope', () => {
    const cursor = decodeSavedCursor(encodeSavedCursor(savedRow('subject-1')));
    expect(savedCursorParameters(cursor!)).toEqual({
      cursorSubjectType: 'studio_release',
      cursorSubjectId: 'subject-1',
      cursorSavedAt: savedAt.toISOString(),
    });
    expect(SAVED_AFTER_CURSOR_SQL).toContain(
      '"cursor_item"."user_id" = :userId',
    );
    expect(SAVED_AFTER_CURSOR_SQL).toContain('NOT EXISTS');
  });
});
