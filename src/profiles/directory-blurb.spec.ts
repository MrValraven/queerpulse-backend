import {
  DIRECTORY_BLURB_MAX_CHARS,
  directoryBlurb,
  truncateAtWord,
} from './directory-blurb';

// Mirrors the frontend suite at src/features/members/directoryBlurb.test.ts.
// The two halves of this rule must agree character for character — if you change
// a case here, change it there.
const LONG_BIO =
  "I build things for the web and spend most weekends cooking for more people than my kitchen was designed for. Lately I've been learning to bind books.";

describe('truncateAtWord', () => {
  it('returns text within the limit untouched', () => {
    expect(truncateAtWord('Fullstack developer')).toBe('Fullstack developer');
  });

  it('collapses runs of whitespace', () => {
    expect(truncateAtWord('Cooks  a\n lot')).toBe('Cooks a lot');
  });

  it('cuts on a word boundary and never exceeds the limit', () => {
    const result = truncateAtWord(LONG_BIO);
    expect(result.length).toBeLessThanOrEqual(DIRECTORY_BLURB_MAX_CHARS + 1);
    expect(result.endsWith('…')).toBe(true);
    // The cut lands between words — no half-word before the ellipsis.
    expect(LONG_BIO.startsWith(result.slice(0, -1))).toBe(true);
    expect(LONG_BIO[result.length - 1]).toBe(' ');
  });

  it('drops punctuation left dangling by the cut', () => {
    expect(truncateAtWord('Designer, cook, and neighbour', 10)).toBe(
      'Designer…',
    );
  });

  it('cuts mid-word when a single word is longer than the limit', () => {
    expect(truncateAtWord('Supercalifragilistic', 10)).toBe('Supercalif…');
  });

  it('keeps a word that ends exactly on the limit', () => {
    expect(truncateAtWord('Cooks a lot always', 11)).toBe('Cooks a lot…');
  });

  it('marks the cut with one ellipsis character, not three dots', () => {
    const result = truncateAtWord(LONG_BIO);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toMatch(/\.\.\.$/);
  });
});

describe('directoryBlurb', () => {
  it('prefers the short bio when there is one', () => {
    expect(directoryBlurb('Fullstack developer', LONG_BIO)).toBe(
      'Fullstack developer',
    );
  });

  it('never truncates a written short bio — the card CSS clamps it', () => {
    const longTagline = 'a'.repeat(DIRECTORY_BLURB_MAX_CHARS + 40);
    expect(directoryBlurb(longTagline, LONG_BIO)).toBe(longTagline);
  });

  it('trims the short bio', () => {
    expect(directoryBlurb('  Cooks a lot  ', LONG_BIO)).toBe('Cooks a lot');
  });

  it('borrows the bio opening when the short bio is empty', () => {
    expect(directoryBlurb('', LONG_BIO)).toBe(truncateAtWord(LONG_BIO));
  });

  it('shows a short bio whole, with no ellipsis', () => {
    expect(directoryBlurb('', 'Cooks a lot')).toBe('Cooks a lot');
  });

  it('treats a whitespace-only short bio as empty', () => {
    expect(directoryBlurb('   ', 'Cooks a lot')).toBe('Cooks a lot');
  });

  it('returns empty when the member has written neither', () => {
    expect(directoryBlurb('', '')).toBe('');
    expect(directoryBlurb(undefined, undefined)).toBe('');
    // The entity stores unwritten fields as NULL, not ''.
    expect(directoryBlurb(null, null)).toBe('');
  });
});
