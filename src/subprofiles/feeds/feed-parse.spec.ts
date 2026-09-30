import {
  MAX_DESCRIPTION_LENGTH,
  MAX_FEED_EPISODES,
  NotAFeedError,
  episodeGuid,
  parseDuration,
  parseEpisodeNumber,
  parsePodcastFeed,
  parsePubDate,
  toPlainText,
  truncateText,
} from './feed-parse';

const rss = (channelBody: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>${channelBody}</channel>
</rss>`;

const FULL_FEED = rss(`
  <title>Queer Joy &amp; Friends</title>
  <link>https://queerjoy.example/</link>
  <description><![CDATA[<p>A show about <b>joy</b>.</p>]]></description>
  <itunes:author>Robin &amp; Sam</itunes:author>
  <itunes:image href="https://cdn.example/show.jpg"/>
  <image><url>https://cdn.example/fallback.jpg</url></image>
  <item>
    <title>Episode 2: <![CDATA[Pride & Prejudice]]></title>
    <guid isPermaLink="false">ep-2</guid>
    <link>https://queerjoy.example/ep-2</link>
    <pubDate>Tue, 10 Jun 2025 04:00:00 GMT</pubDate>
    <description><![CDATA[<p>First paragraph.</p><p>Second &amp; <em>last</em>.</p><script>alert(1)</script>]]></description>
    <enclosure url="https://cdn.example/ep-2.mp3" length="1" type="audio/mpeg"/>
    <itunes:duration>1:12:03</itunes:duration>
    <itunes:season>2</itunes:season>
    <itunes:episode>14</itunes:episode>
    <itunes:image href="https://cdn.example/ep-2.jpg"/>
  </item>
  <item>
    <title>Episode 1</title>
    <guid>ep-1</guid>
    <pubDate>Mon, 02 Jun 2025 04:00:00 +0000</pubDate>
    <itunes:summary>Summary only</itunes:summary>
    <enclosure url="https://cdn.example/ep-1.mp3" length="1" type="audio/mpeg"/>
    <itunes:duration>2880</itunes:duration>
  </item>
`);

describe('parsePodcastFeed', () => {
  it('reads the channel: title, author, description and show art', () => {
    const feed = parsePodcastFeed(FULL_FEED);
    expect(feed.title).toBe('Queer Joy & Friends');
    expect(feed.author).toBe('Robin & Sam');
    expect(feed.description).toBe('A show about joy.');
    expect(feed.imageUrl).toBe('https://cdn.example/show.jpg');
    expect(feed.episodeCount).toBe(2);
  });

  it('maps every episode field, newest first', () => {
    const [latest, older] = parsePodcastFeed(FULL_FEED).episodes;
    expect(latest).toEqual({
      guid: 'ep-2',
      title: 'Episode 2: Pride & Prejudice',
      description: 'First paragraph. Second & last.',
      link: 'https://queerjoy.example/ep-2',
      publishedAt: new Date('2025-06-10T04:00:00Z'),
      durationSeconds: 72 * 60 + 3,
      season: 2,
      episode: 14,
      imageUrl: 'https://cdn.example/ep-2.jpg',
    });
    expect(older).toEqual({
      guid: 'ep-1',
      title: 'Episode 1',
      description: 'Summary only',
      // No page link: the enclosure URL stands in.
      link: 'https://cdn.example/ep-1.mp3',
      publishedAt: new Date('2025-06-02T04:00:00Z'),
      durationSeconds: 2880,
      season: null,
      episode: null,
      imageUrl: null,
    });
  });

  it('sorts by publish date even when the document does not', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Out of order</title>
        <item><title>Old</title><guid>a</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
        <item><title>Undated</title><guid>b</guid></item>
        <item><title>New</title><guid>c</guid><pubDate>Wed, 01 Jan 2025 00:00:00 GMT</pubDate></item>
      `),
    );
    expect(feed.episodes.map((episode) => episode.title)).toEqual([
      'New',
      'Old',
      'Undated',
    ]);
  });

  it('falls back to image/url for show art and to content:encoded for text', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Fallbacks</title>
        <image><url>https://cdn.example/fallback.jpg</url></image>
        <item>
          <title>Only encoded</title>
          <guid>x</guid>
          <content:encoded><![CDATA[<h2>Notes</h2><ul><li>One</li><li>Two</li></ul>]]></content:encoded>
        </item>
      `),
    );
    expect(feed.imageUrl).toBe('https://cdn.example/fallback.jpg');
    expect(feed.episodes[0]?.description).toBe('Notes One Two');
  });

  it('decodes entity-encoded HTML inside CDATA and strips it', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Encoded</title>
        <item>
          <title>Encoded body</title>
          <guid>x</guid>
          <description><![CDATA[&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt; &rsquo;quoted&rsquo;&nbsp;done]]></description>
        </item>
      `),
    );
    expect(feed.episodes[0]?.description).toBe('Hello & welcome ’quoted’ done');
  });

  it('decodes entities in plain (non-CDATA) text', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Caf&#233; &lt;3</title>
        <item><title>Tom &#x26; Jerry</title><guid>x</guid></item>
      `),
    );
    expect(feed.title).toBe('Café <3');
    expect(feed.episodes[0]?.title).toBe('Tom & Jerry');
  });

  it('skips items with no title and tolerates missing fields', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Sparse</title>
        <item><guid>no-title</guid><description>nothing</description></item>
        <item><title>   </title><guid>blank-title</guid></item>
        <item><title>Bare</title></item>
      `),
    );
    expect(feed.episodes).toHaveLength(1);
    const [bare] = feed.episodes;
    expect(bare?.guid).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect({ ...bare, guid: 'hashed' }).toEqual({
      guid: 'hashed',
      title: 'Bare',
      description: null,
      link: null,
      publishedAt: null,
      durationSeconds: null,
      season: null,
      episode: null,
      imageUrl: null,
    });
    expect(feed.author).toBeNull();
    expect(feed.imageUrl).toBeNull();
  });

  it('keeps a channel with no items as an empty show', () => {
    const feed = parsePodcastFeed(rss('<title>Coming soon</title>'));
    expect(feed.title).toBe('Coming soon');
    expect(feed.episodes).toEqual([]);
  });

  it('dedupes repeated guids, keeping the first', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Dupes</title>
        <item><title>First</title><guid>same</guid></item>
        <item><title>Second</title><guid>same</guid></item>
      `),
    );
    expect(feed.episodes.map((episode) => episode.title)).toEqual(['First']);
  });

  it('refuses non-http(s) links and art', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Schemes</title>
        <itunes:image href="javascript:alert(1)"/>
        <item>
          <title>Bad link</title>
          <guid>x</guid>
          <link>javascript:alert(1)</link>
          <enclosure url="ftp://files.example/ep.mp3"/>
          <itunes:image href="data:image/png;base64,AAAA"/>
        </item>
      `),
    );
    expect(feed.imageUrl).toBeNull();
    expect(feed.episodes[0]?.link).toBeNull();
    expect(feed.episodes[0]?.imageUrl).toBeNull();
  });

  it('caps a description at 2000 characters', () => {
    const feed = parsePodcastFeed(
      rss(`
        <title>Long</title>
        <item><title>Long</title><guid>x</guid><description>${'word '.repeat(1000)}</description></item>
      `),
    );
    const description = feed.episodes[0]?.description ?? '';
    expect(description.length).toBe(MAX_DESCRIPTION_LENGTH);
    expect(description.endsWith('…')).toBe(true);
  });

  it('keeps only the newest 500 episodes but counts them all', () => {
    const items = Array.from(
      { length: 520 },
      (_, index) =>
        `<item><title>Ep ${index}</title><guid>g-${index}</guid><pubDate>${new Date(
          Date.UTC(2020, 0, 1) + index * 86_400_000,
        ).toUTCString()}</pubDate></item>`,
    ).join('');
    const feed = parsePodcastFeed(rss(`<title>Big</title>${items}`));
    expect(feed.episodeCount).toBe(520);
    expect(feed.episodes).toHaveLength(MAX_FEED_EPISODES);
    expect(feed.episodes[0]?.title).toBe('Ep 519');
    expect(feed.episodes[MAX_FEED_EPISODES - 1]?.title).toBe('Ep 20');
  });

  describe('not a feed', () => {
    it.each([
      [
        'Atom',
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>x</title></entry></feed>`,
      ],
      [
        'HTML',
        '<!doctype html><html><head><title>A page</title></head><body><p>Hi</p></body></html>',
      ],
      [
        'RSS 1.0 (RDF)',
        `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>x</title></channel></rdf:RDF>`,
      ],
      ['rss without a channel', '<rss version="2.0"></rss>'],
      ['plain text', 'just some text'],
      ['JSON', '{"title":"not xml"}'],
    ])('%s', (_label, body) => {
      expect(() => parsePodcastFeed(body)).toThrow(NotAFeedError);
    });

    it('refuses any entity declaration (billion laughs)', () => {
      const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<rss version="2.0"><channel><title>&lol2;</title></channel></rss>`;
      expect(() => parsePodcastFeed(bomb)).toThrow(NotAFeedError);
    });

    it('refuses an external entity declaration', () => {
      const xxe = `<?xml version="1.0"?>
<!DOCTYPE rss [<!entity xxe SYSTEM "file:///etc/passwd">]>
<rss version="2.0"><channel><title>&xxe;</title></channel></rss>`;
      expect(() => parsePodcastFeed(xxe)).toThrow(NotAFeedError);
    });
  });
});

describe('parseDuration', () => {
  it.each([
    ['3600', 3600],
    ['3600.7', 3600],
    ['48:05', 48 * 60 + 5],
    ['1:12:03', 72 * 60 + 3],
    ['01:02:03', 3723],
    ['0:30', 30],
    [' 2880 ', 2880],
    ['100:00', 6000],
  ])('%s -> %s seconds', (raw, expected) => {
    expect(parseDuration(raw)).toBe(expected);
  });

  it.each([
    [null],
    [''],
    ['0'],
    ['00:00'],
    ['abc'],
    ['45 min'],
    ['1:75'],
    ['1:2:3:4'],
    ['-30'],
    ['999999999'],
  ])('%s -> null', (raw) => {
    expect(parseDuration(raw)).toBeNull();
  });
});

describe('parsePubDate', () => {
  it.each([
    ['Tue, 10 Jun 2025 04:00:00 GMT', '2025-06-10T04:00:00.000Z'],
    ['Tue, 10 Jun 2025 04:00:00 +0200', '2025-06-10T02:00:00.000Z'],
    ['10 Jun 2025 04:00:00 PDT', '2025-06-10T11:00:00.000Z'],
    ['Tue, 3 Jun 2025 04:00 EST', '2025-06-03T09:00:00.000Z'],
    ['Tues, 10 Jun 2025 04:00:00 GMT', '2025-06-10T04:00:00.000Z'],
    ['Tue, 10 Jun 2025 04:00:00 CEST', '2025-06-10T04:00:00.000Z'],
    ['2025-06-10T04:00:00Z', '2025-06-10T04:00:00.000Z'],
  ])('%s', (raw, iso) => {
    expect(parsePubDate(raw)?.toISOString()).toBe(iso);
  });

  it.each([[null], [''], ['not a date at all']])('%s -> null', (raw) => {
    expect(parsePubDate(raw)).toBeNull();
  });
});

describe('parseEpisodeNumber', () => {
  it.each([
    ['14', 14],
    [' 007 ', 7],
    ['0', 0],
  ])('%s -> %s', (raw, expected) => {
    expect(parseEpisodeNumber(raw)).toBe(expected);
  });

  it.each([[null], [''], ['1.5'], ['-2'], ['two'], ['99999999']])(
    '%s -> null',
    (raw) => {
      expect(parseEpisodeNumber(raw)).toBeNull();
    },
  );
});

describe('episodeGuid', () => {
  it('prefers the guid, then the enclosure, then the link', () => {
    expect(episodeGuid('g', 'https://e/x.mp3', 'https://l', 'T', null)).toBe(
      'g',
    );
    expect(episodeGuid(null, 'https://e/x.mp3', 'https://l', 'T', null)).toBe(
      'https://e/x.mp3',
    );
    expect(episodeGuid('  ', null, 'https://l', 'T', null)).toBe('https://l');
  });

  it('hashes title + pubDate when nothing else identifies the episode', () => {
    const first = episodeGuid(null, null, null, 'Title', 'Mon, 1 Jan 2024');
    expect(first).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(episodeGuid(null, null, null, 'Title', 'Mon, 1 Jan 2024')).toBe(
      first,
    );
    expect(episodeGuid(null, null, null, 'Title', 'Tue, 2 Jan 2024')).not.toBe(
      first,
    );
  });

  it('hashes a guid too long for the column', () => {
    expect(episodeGuid('x'.repeat(600), null, null, 'T', null)).toMatch(
      /^sha1:[0-9a-f]{40}$/,
    );
  });
});

describe('toPlainText / truncateText', () => {
  it('strips tags, drops script content and collapses whitespace', () => {
    expect(
      toPlainText('<p>One</p>\n\n<p>Two<br>Three</p><script>x()</script>'),
    ).toBe('One Two Three');
  });

  it('does not fold &amp;lt; into a tag', () => {
    expect(toPlainText('a &amp;lt;b&amp;gt; c')).toBe('a c');
  });

  it('truncates with an ellipsis only when needed', () => {
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('exactly10!', 10)).toBe('exactly10!');
    expect(truncateText('a bit too long', 10)).toBe('a bit too…');
  });
});
