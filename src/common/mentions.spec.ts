import { extractMentions, extractMentionSlugs } from './mentions';

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

  it('still returns members only, delegating to extractMentions', () => {
    const body = '@ana c/creatives b/queer-books e/pride-march t/welcome';
    expect(extractMentionSlugs(body)).toEqual(['ana']);
  });
});

describe('extractMentions', () => {
  it('groups tokens of every notify-able kind into their own bucket', () => {
    const body =
      'hi @ana-costa, join c/creatives, check out b/queer-books, come to e/pride-march, see t/welcome-thread';
    expect(extractMentions(body)).toEqual({
      members: ['ana-costa'],
      communities: ['creatives'],
      businesses: ['queer-books'],
      events: ['pride-march'],
      threads: ['welcome-thread'],
    });
  });

  it('dedupes repeated tokens per kind, preserving first-seen order', () => {
    const body = '@ana c/creatives @rui c/creatives @ana';
    expect(extractMentions(body)).toEqual({
      members: ['ana', 'rui'],
      communities: ['creatives'],
      businesses: [],
      events: [],
      threads: [],
    });
  });

  it('enforces the boundary rule — no match mid-word (e.g. an email address)', () => {
    const body =
      'mail me@host.com or see c/x inside sourc/e-code and reach b/end';
    expect(extractMentions(body)).toEqual({
      members: [],
      communities: ['x'],
      businesses: ['end'],
      events: [],
      threads: [],
    });
  });

  it('excludes topic (#) tokens — topics never notify', () => {
    const body = 'talking about #pride and @ana in the same post';
    expect(extractMentions(body)).toEqual({
      members: ['ana'],
      communities: [],
      businesses: [],
      events: [],
      threads: [],
    });
  });

  it('returns all-empty buckets when there are no tokens', () => {
    expect(extractMentions('plain text')).toEqual({
      members: [],
      communities: [],
      businesses: [],
      events: [],
      threads: [],
    });
  });
});
