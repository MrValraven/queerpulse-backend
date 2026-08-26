import {
  CONNECTION_SEARCH_HAYSTACK,
  foldedTextExpression,
} from './connection-search';

describe('connection search folding (SOC-14)', () => {
  const emitted = foldedTextExpression('other.first_name');

  it('folds case and accents in one expression', () => {
    expect(emitted.startsWith('translate(lower(other.first_name)')).toBe(true);
  });

  it('maps every accented character to exactly one plain character', () => {
    // Postgres `translate(string, from, to)` DELETES any character in `from`
    // that has no counterpart in `to`. A shorter replacement map would
    // silently drop letters from the haystack instead of folding them, so the
    // two maps being the same length is the whole correctness condition.
    const [, accented, plain] =
      /'([^']*)',\s*'([^']*)'/.exec(emitted) ?? ([] as string[]);
    expect(accented).toBeDefined();
    expect([...(accented ?? '')]).toHaveLength([...(plain ?? '')].length);
  });

  it('folds the Portuguese letters this audience actually types', () => {
    const [, accented, plain] =
      /'([^']*)',\s*'([^']*)'/.exec(emitted) ?? ([] as string[]);
    const foldOf = (character: string): string | undefined => {
      const index = [...(accented ?? '')].indexOf(character);
      return index === -1 ? undefined : [...(plain ?? '')][index];
    };
    // "Sao" must find "Sao Paulo" spelled the way it is actually spelled, and
    // "ines" must find "Ines".
    expect(foldOf('ã')).toBe('a');
    expect(foldOf('ê')).toBe('e');
    expect(foldOf('ç')).toBe('c');
    expect(foldOf('õ')).toBe('o');
    expect(foldOf('ú')).toBe('u');
  });

  it('searches the name, the handle, and the headline', () => {
    expect(CONNECTION_SEARCH_HAYSTACK).toContain('other.first_name');
    expect(CONNECTION_SEARCH_HAYSTACK).toContain('other.last_name');
    expect(CONNECTION_SEARCH_HAYSTACK).toContain('other.slug');
    expect(CONNECTION_SEARCH_HAYSTACK).toContain('other.tagline');
  });

  it('applies the same fold to a bound parameter, so both sides match', () => {
    expect(foldedTextExpression(':searchPattern')).toContain(
      'lower(:searchPattern)',
    );
  });
});
