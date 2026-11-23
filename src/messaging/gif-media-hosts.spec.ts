import {
  GIF_HOST_NOT_ALLOWED_CODE,
  isAllowedGifMediaUrl,
} from './gif-media-hosts';

/** SEC-24: a GIF message's `url` and `previewUrl` stay on KLIPY's hosts. */
describe('isAllowedGifMediaUrl', () => {
  it.each([
    'https://static.klipy.com/ii/abc/wave.gif',
    'https://static.klipy.com/ii/abc/wave-small.webp',
    'https://klipy.com/media/wave.gif',
  ])('accepts %s', (url) => {
    expect(isAllowedGifMediaUrl(url)).toBe(true);
  });

  it.each([
    ['another host', 'https://tracker.example/pixel.gif'],
    ['a look-alike host', 'https://static.klipy.com.evil.example/wave.gif'],
    ['a suffix trick', 'https://evilklipy.com/wave.gif'],
    ['plain http', 'http://static.klipy.com/wave.gif'],
    ['credentials', 'https://user:pass@static.klipy.com/wave.gif'],
    ['an explicit port', 'https://static.klipy.com:8443/wave.gif'],
    ['a data URL', 'data:image/gif;base64,R0lGOD'],
    ['text that is no URL', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedGifMediaUrl(url)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isAllowedGifMediaUrl(undefined)).toBe(false);
    expect(isAllowedGifMediaUrl(42)).toBe(false);
  });

  it('names the refusal with a stable code', () => {
    expect(GIF_HOST_NOT_ALLOWED_CODE).toBe('GIF_HOST_NOT_ALLOWED');
  });
});
