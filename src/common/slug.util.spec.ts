import { allocateUniqueSlug, slugify } from './slug.util';

describe('slugify', () => {
  it('normalizes accents, case, and separators', () => {
    expect(slugify('Atelier Pulso!')).toBe('atelier-pulso');
    expect(slugify('Tomás Mendes')).toBe('tomas-mendes');
  });
  it('falls back when empty', () => {
    expect(slugify('!!!', 'community')).toBe('community');
  });
});

describe('allocateUniqueSlug', () => {
  it('returns the base when free', async () => {
    expect(
      await allocateUniqueSlug('atelier-pulso', () => Promise.resolve(false)),
    ).toBe('atelier-pulso');
  });
  it('suffixes on collision', async () => {
    const taken = new Set(['atelier-pulso']);
    const slug = await allocateUniqueSlug('atelier-pulso', (s) =>
      Promise.resolve(taken.has(s)),
    );
    expect(slug).toMatch(/^atelier-pulso-[0-9a-f]{6}$/);
  });
});
