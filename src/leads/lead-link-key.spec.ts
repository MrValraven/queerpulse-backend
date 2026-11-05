import { LEAD_SOCIAL_HOSTS, leadLinkKey } from './lead-link-key';

describe('leadLinkKey', () => {
  it('keys the contract examples', () => {
    expect(leadLinkKey('https://www.Instagram.com/Ana.Dj/?igsh=abc')).toBe(
      'instagram.com/Ana.Dj',
    );
    expect(leadLinkKey('http://instagram.com/Ana.Dj')).toBe(
      'instagram.com/Ana.Dj',
    );
    expect(leadLinkKey('https://example.org/press?id=4#top')).toBe(
      'example.org/press?id=4',
    );
  });

  it('keeps the video id of a YouTube watch page', () => {
    expect(leadLinkKey('https://www.youtube.com/watch?v=abc&t=10')).toBe(
      'youtube.com/watch?v=abc',
    );
    expect(leadLinkKey('https://music.youtube.com/watch?list=x')).toBe(
      'music.youtube.com/watch',
    );
    expect(leadLinkKey('https://youtu.be/abc?si=1')).toBe('youtu.be/abc');
  });

  it('drops the query of every social subdomain', () => {
    expect(leadLinkKey('https://open.spotify.com/artist/X?si=1')).toBe(
      'open.spotify.com/artist/X',
    );
    expect(leadLinkKey('https://artist.bandcamp.com/?from=1')).toBe(
      'artist.bandcamp.com',
    );
    expect(leadLinkKey('https://m.facebook.com/ana?ref=share')).toBe(
      'm.facebook.com/ana',
    );
  });

  it('keeps the query of a host that only ends with a social name', () => {
    expect(leadLinkKey('https://notinstagram.com/a?b=1')).toBe(
      'notinstagram.com/a?b=1',
    );
  });

  it('keeps a port the parser keeps and drops a default one', () => {
    expect(leadLinkKey('https://example.org:8443/a/')).toBe(
      'example.org:8443/a',
    );
    expect(leadLinkKey('https://example.org:443/')).toBe('example.org');
  });

  it('removes one leading www and keeps path case', () => {
    expect(leadLinkKey('https://www.www.x.org/Path//')).toBe('www.x.org/Path');
  });

  it('keys the trimmed text', () => {
    expect(leadLinkKey('  https://example.org/a  ')).toBe('example.org/a');
  });

  it('answers null for no http link', () => {
    for (const text of [
      'ftp://x.org',
      'mailto:a@b.co',
      'not a url',
      'instagram.com/ana',
      '',
    ]) {
      expect(leadLinkKey(text)).toBeNull();
    }
  });

  it('lists the fourteen social hosts', () => {
    expect(LEAD_SOCIAL_HOSTS).toEqual([
      'instagram.com',
      'tiktok.com',
      'soundcloud.com',
      'spotify.com',
      'bandcamp.com',
      'youtube.com',
      'youtu.be',
      'facebook.com',
      'fb.com',
      'x.com',
      'twitter.com',
      'ra.co',
      'residentadvisor.net',
      'mixcloud.com',
    ]);
  });
});
