import { normalizeFeedUrl } from './feed-url';

describe('normalizeFeedUrl', () => {
  it.each([
    ['https://feeds.example/show', 'https://feeds.example/show'],
    ['  http://feeds.example/show.xml  ', 'http://feeds.example/show.xml'],
    ['feeds.example/show', 'https://feeds.example/show'],
    ['feed://feeds.example/show', 'https://feeds.example/show'],
    ['feed:https://feeds.example/show', 'https://feeds.example/show'],
    ['itpc://feeds.example/show', 'https://feeds.example/show'],
    ['pcast://feeds.example/show', 'https://feeds.example/show'],
    ['podcast://feeds.example/show', 'https://feeds.example/show'],
    ['https://feeds.example/show#latest', 'https://feeds.example/show'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeFeedUrl(raw)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['javascript:alert(1)'],
    ['ftp://feeds.example/show'],
    ['file:///etc/passwd'],
    ['https://user:secret@feeds.example/show'],
    ['https://'],
    [`https://feeds.example/${'x'.repeat(2100)}`],
  ])('refuses %s', (raw) => {
    expect(normalizeFeedUrl(raw)).toBeNull();
  });
});
