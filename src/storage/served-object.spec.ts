import {
  contentTypeForStorageKey,
  inlineContentDispositionForStorageKey,
  magicBytesMatchContentType,
} from './served-object';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const GIF89 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
// HTML masquerading as an image ("<!DOCTYPE" -> 3C 21 44 4F ...).
const HTML = Uint8Array.from([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54]);

describe('contentTypeForStorageKey', () => {
  it.each([
    ['avatars/u/f.jpg', 'image/jpeg'],
    ['work/u/f.png', 'image/png'],
    ['story-covers/u/f.webp', 'image/webp'],
    ['message-images/u/f.gif', 'image/gif'],
  ])('maps %s -> %s', (key, expected) => {
    expect(contentTypeForStorageKey(key)).toBe(expected);
  });

  it('returns null for an unknown extension or no extension', () => {
    expect(contentTypeForStorageKey('avatars/u/f.svg')).toBeNull();
    expect(contentTypeForStorageKey('avatars/u/f')).toBeNull();
  });
});

describe('inlineContentDispositionForStorageKey', () => {
  it('uses only the final (server-minted) path segment as the filename', () => {
    expect(inlineContentDispositionForStorageKey('avatars/u/abc.jpg')).toBe(
      'inline; filename="abc.jpg"',
    );
  });
});

describe('magicBytesMatchContentType', () => {
  it('accepts bytes that match their declared type', () => {
    expect(magicBytesMatchContentType(JPEG, 'image/jpeg')).toBe(true);
    expect(magicBytesMatchContentType(PNG, 'image/png')).toBe(true);
    expect(magicBytesMatchContentType(GIF89, 'image/gif')).toBe(true);
    expect(magicBytesMatchContentType(WEBP, 'image/webp')).toBe(true);
  });

  it('rejects bytes whose signature contradicts the declared type', () => {
    expect(magicBytesMatchContentType(HTML, 'image/png')).toBe(false);
    expect(magicBytesMatchContentType(PNG, 'image/jpeg')).toBe(false);
    // A truncated RIFF header without the WEBP fourCC is not a webp.
    expect(
      magicBytesMatchContentType(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
        'image/webp',
      ),
    ).toBe(false);
  });

  it('rejects a null content type outright', () => {
    expect(magicBytesMatchContentType(JPEG, null)).toBe(false);
  });
});
