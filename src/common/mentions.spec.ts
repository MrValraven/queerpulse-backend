import { extractMentionSlugs } from './mentions';

describe('extractMentionSlugs', () => {
  it('extracts a single @mention', () => {
    expect(extractMentionSlugs('hi @ana-costa')).toEqual(['ana-costa']);
  });

  it('dedupes repeated mentions, preserving first-seen order', () => {
    expect(extractMentionSlugs('@ana @rui @ana')).toEqual(['ana', 'rui']);
  });

  it('ignores c/community tokens', () => {
    expect(extractMentionSlugs('see c/creatives @ana')).toEqual(['ana']);
  });

  it('does not treat an email as a mention', () => {
    expect(extractMentionSlugs('mail me@host.com')).toEqual([]);
  });

  it('returns an empty array when there are no mentions', () => {
    expect(extractMentionSlugs('plain text')).toEqual([]);
  });
});
