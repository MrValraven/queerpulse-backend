import {
  STUDIO_PREVIEW_TOKEN_PATTERN,
  isStudioPreviewToken,
  mintStudioPreviewToken,
} from './studio-preview-token';

describe('Studio preview tokens', () => {
  it('mints 64 lowercase hex characters, a fresh one every time', () => {
    const first = mintStudioPreviewToken();
    const second = mintStudioPreviewToken();
    expect(first).toMatch(STUDIO_PREVIEW_TOKEN_PATTERN);
    expect(second).toMatch(STUDIO_PREVIEW_TOKEN_PATTERN);
    expect(first).not.toBe(second);
  });

  it.each([
    ['a short token', 'ab12'],
    ['upper-case hex', 'A'.repeat(64)],
    ['a token with a slash', `${'a'.repeat(63)}/`],
    ['65 characters', 'a'.repeat(65)],
    ['an empty string', ''],
  ])('refuses %s', (_label, value) => {
    expect(isStudioPreviewToken(value)).toBe(false);
  });

  it('accepts a minted token', () => {
    expect(isStudioPreviewToken(mintStudioPreviewToken())).toBe(true);
  });
});
