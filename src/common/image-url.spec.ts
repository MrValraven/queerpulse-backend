import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from './image-url';

const STORAGE_KEY =
  'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg';

describe('toImageUrl', () => {
  beforeEach(() => {
    resetImageUrlBaseForTesting();
    setImageUrlBase('https://api.queerpulse.app');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('turns a storage key into an API files URL', () => {
    expect(toImageUrl(STORAGE_KEY)).toBe(
      `https://api.queerpulse.app/files/${STORAGE_KEY}`,
    );
  });

  it('passes an external https URL through untouched', () => {
    const googleAvatar = 'https://lh3.googleusercontent.com/a/photo=s96-c';
    expect(toImageUrl(googleAvatar)).toBe(googleAvatar);
  });

  it('passes a seeded Unsplash URL through untouched', () => {
    const unsplash =
      'https://images.unsplash.com/photo-1611178204388-1deef70ec66a?q=80&w=400';
    expect(toImageUrl(unsplash)).toBe(unsplash);
  });

  it('returns null for null', () => {
    expect(toImageUrl(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(toImageUrl(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(toImageUrl('')).toBeNull();
  });

  it('drops a value that is neither a key nor an https URL', () => {
    expect(toImageUrl('javascript:alert(1)')).toBeNull();
    expect(toImageUrl('data:image/svg+xml,<svg/>')).toBeNull();
  });

  it('does not double up slashes when the base URL has a trailing slash', () => {
    setImageUrlBase('https://api.queerpulse.app/');
    expect(toImageUrl(STORAGE_KEY)).toBe(
      `https://api.queerpulse.app/files/${STORAGE_KEY}`,
    );
  });

  it('throws when a key is converted before the base URL is set', () => {
    resetImageUrlBaseForTesting();
    expect(() => toImageUrl(STORAGE_KEY)).toThrow(
      /Image URL base is not configured/,
    );
  });

  it('still passes external URLs through before the base URL is set', () => {
    resetImageUrlBaseForTesting();
    expect(toImageUrl('https://images.unsplash.com/photo-1')).toBe(
      'https://images.unsplash.com/photo-1',
    );
  });
});
