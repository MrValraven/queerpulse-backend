import {
  LINK_PREVIEW_IMAGE_URL_MAX_LENGTH,
  isSignableImageUrl,
  signLinkPreviewImageToken,
  verifyLinkPreviewImageToken,
} from './link-preview-image-token';

const IMAGE_URL = 'https://elsewhere.example/og/card.png?v=2';

describe('link preview image tokens (SEC-23)', () => {
  it('verifies a token back to the image URL it was minted for', () => {
    const token = signLinkPreviewImageToken(IMAGE_URL);

    expect(verifyLinkPreviewImageToken(token)).toBe(IMAGE_URL);
  });

  it('keeps the token path-safe', () => {
    const token = signLinkPreviewImageToken(IMAGE_URL);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a token whose URL part was swapped for another address', () => {
    const token = signLinkPreviewImageToken(IMAGE_URL);
    const macPart = token.split('.')[1] ?? '';
    const forgedUrlPart = Buffer.from(
      'https://attacker.example/x.png',
    ).toString('base64url');

    expect(
      verifyLinkPreviewImageToken(`${forgedUrlPart}.${macPart}`),
    ).toBeNull();
  });

  it('refuses a token whose MAC was edited', () => {
    const token = signLinkPreviewImageToken(IMAGE_URL);
    const [urlPart, macPart = ''] = token.split('.');
    const editedMac = `${macPart.startsWith('A') ? 'B' : 'A'}${macPart.slice(1)}`;

    expect(verifyLinkPreviewImageToken(`${urlPart}.${editedMac}`)).toBeNull();
  });

  it.each([
    '',
    'not-a-token',
    `${Buffer.from(IMAGE_URL).toString('base64url')}.short`,
    `${Buffer.from(IMAGE_URL).toString('base64url')}.${'a'.repeat(43)}`,
    `../etc.${'a'.repeat(43)}`,
  ])('refuses the malformed token %p', (token) => {
    expect(verifyLinkPreviewImageToken(token)).toBeNull();
  });

  it('signs only http(s) URLs within the length cap', () => {
    expect(isSignableImageUrl(IMAGE_URL)).toBe(true);
    expect(isSignableImageUrl('http://elsewhere.example/a.gif')).toBe(true);
    expect(isSignableImageUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isSignableImageUrl('file:///etc/passwd')).toBe(false);
    expect(isSignableImageUrl('not a url')).toBe(false);
    expect(
      isSignableImageUrl(
        `https://elsewhere.example/${'a'.repeat(LINK_PREVIEW_IMAGE_URL_MAX_LENGTH)}`,
      ),
    ).toBe(false);
  });

  it('refuses a correctly signed token whose URL is not an http(s) image URL', () => {
    const token = signLinkPreviewImageToken('javascript:alert(1)');

    expect(verifyLinkPreviewImageToken(token)).toBeNull();
  });

  it('refuses a MAC spelled with non-canonical trailing bits', () => {
    const token = signLinkPreviewImageToken(IMAGE_URL);
    const [urlPart, macPart = ''] = token.split('.');
    // 43 characters carry 258 bits for a 256-bit MAC: the last character's
    // low two bits are padding, so flipping one decodes to the same bytes.
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastIndex = alphabet.indexOf(macPart.slice(-1));
    const sameBytesChar = alphabet[lastIndex ^ 1] ?? '';
    const respelledMac = `${macPart.slice(0, -1)}${sameBytesChar}`;

    expect(Buffer.from(respelledMac, 'base64url')).toEqual(
      Buffer.from(macPart, 'base64url'),
    );
    expect(
      verifyLinkPreviewImageToken(`${urlPart}.${respelledMac}`),
    ).toBeNull();
  });

  it('refuses a URL part spelled with non-canonical trailing bits', () => {
    // 'https://a.example/x.png' is 23 bytes: 31 characters with 2 spare bits.
    const imageUrl = 'https://a.example/x.png';
    const token = signLinkPreviewImageToken(imageUrl);
    const [urlPart = '', macPart = ''] = token.split('.');
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastIndex = alphabet.indexOf(urlPart.slice(-1));
    const respelledUrlPart = `${urlPart.slice(0, -1)}${alphabet[lastIndex ^ 1] ?? ''}`;

    expect(Buffer.from(respelledUrlPart, 'base64url').toString('utf8')).toBe(
      imageUrl,
    );
    expect(
      verifyLinkPreviewImageToken(`${respelledUrlPart}.${macPart}`),
    ).toBeNull();
  });
});
