import {
  isStorageKey,
  parseStorageKey,
  storageKeyOwnerId,
} from './storage-key';

const VALID_AVATAR_KEY =
  'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg';
const VALID_GATHERING_KEY =
  'gathering-photos/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.webp';

describe('parseStorageKey', () => {
  it('resolves a public kind and reports it needs no session', () => {
    const spec = parseStorageKey(VALID_AVATAR_KEY);
    expect(spec).not.toBeNull();
    expect(spec?.prefix).toBe('avatars');
    expect(spec?.requiresSession).toBe(false);
  });

  it('resolves gathering photos as session-gated', () => {
    const spec = parseStorageKey(VALID_GATHERING_KEY);
    expect(spec?.prefix).toBe('gathering-photos');
    expect(spec?.requiresSession).toBe(true);
  });

  it.each([
    [
      'an unknown prefix',
      'secrets/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg',
    ],
    ['a traversal attempt', 'avatars/../../etc/passwd'],
    [
      'a traversal attempt inside a valid prefix',
      'avatars/11111111-2222-3333-4444-555555555555/../../../secret.jpg',
    ],
    [
      'a disallowed extension',
      'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.svg',
    ],
    [
      'no extension',
      'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000',
    ],
    ['a non-uuid segment', 'avatars/user-1/file.jpg'],
    ['a missing segment', 'avatars/66666666-7777-8888-9999-000000000000.jpg'],
    ['an absolute URL', 'https://lh3.googleusercontent.com/a/photo.jpg'],
    ['an empty string', ''],
  ])('rejects %s', (_label, candidate) => {
    expect(parseStorageKey(candidate)).toBeNull();
  });
});

describe('isStorageKey', () => {
  it('is true for a well-formed key', () => {
    expect(isStorageKey(VALID_AVATAR_KEY)).toBe(true);
  });

  it('is false for an external URL', () => {
    expect(isStorageKey('https://lh3.googleusercontent.com/a/photo.jpg')).toBe(
      false,
    );
  });
});

describe('storageKeyOwnerId', () => {
  it('extracts the owner user id from a well-formed key', () => {
    expect(storageKeyOwnerId(VALID_AVATAR_KEY)).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
  });

  it('extracts the owner user id regardless of upload kind', () => {
    expect(storageKeyOwnerId(VALID_GATHERING_KEY)).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
  });

  it.each([
    [
      'an unknown prefix',
      'secrets/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg',
    ],
    ['a traversal attempt', 'avatars/../../etc/passwd'],
    [
      'a disallowed extension',
      'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.svg',
    ],
    ['a non-uuid segment', 'avatars/user-1/file.jpg'],
    ['an absolute URL', 'https://lh3.googleusercontent.com/a/photo.jpg'],
    ['an empty string', ''],
  ])('returns null for %s (a malformed key)', (_label, candidate) => {
    expect(storageKeyOwnerId(candidate)).toBeNull();
  });
});
