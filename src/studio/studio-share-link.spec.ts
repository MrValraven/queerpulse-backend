import {
  findStudioShareLink,
  findStudioShareLinkMatch,
  isOwnOriginStudioUrl,
  parseStudioShareLink,
  postTextWithoutStudioShareLink,
  STUDIO_SHARE_MAX_LINE_INDEX,
  STUDIO_SHARE_MAX_START_SECONDS,
  studioShareOrigins,
  textWithoutStudioShareLink,
} from './studio-share-link';

const ORIGINS = ['https://queerpulse.test', 'https://www.queerpulse.test'];
const TRACK_ID = '0f8a3c2e-5b1d-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const TRACK_URL = `https://queerpulse.test/studio/track?id=${TRACK_ID}`;

describe('parseStudioShareLink', () => {
  it.each(ORIGINS)(
    'parses a track link on the configured origin %s',
    (origin) => {
      expect(
        parseStudioShareLink(`${origin}/studio/track?id=${TRACK_ID}`, ORIGINS),
      ).toEqual({
        kind: 'track',
        id: TRACK_ID,
        startAtSeconds: null,
        path: `/studio/track?id=${TRACK_ID}`,
      });
    },
  );

  it('maps the album path to a release and the collection path to a playlist', () => {
    expect(
      parseStudioShareLink(
        `https://queerpulse.test/studio/album?id=${TRACK_ID}`,
        ORIGINS,
      ),
    ).toEqual({
      kind: 'release',
      id: TRACK_ID,
      startAtSeconds: null,
      path: `/studio/album?id=${TRACK_ID}`,
    });
    expect(
      parseStudioShareLink(
        `https://queerpulse.test/studio/collection?id=${TRACK_ID}`,
        ORIGINS,
      ),
    ).toEqual({
      kind: 'playlist',
      id: TRACK_ID,
      startAtSeconds: null,
      path: `/studio/collection?id=${TRACK_ID}`,
    });
  });

  it('parses a root-relative path with no origin at all', () => {
    expect(
      parseStudioShareLink(`/studio/collection?id=${TRACK_ID}`, ORIGINS)?.path,
    ).toBe(`/studio/collection?id=${TRACK_ID}`);
  });

  it('matches the id case-blind and returns it lower-cased', () => {
    const link = parseStudioShareLink(
      `https://queerpulse.test/studio/track?id=${TRACK_ID.toUpperCase()}`,
      ORIGINS,
    );
    expect(link?.id).toBe(TRACK_ID);
    expect(link?.path).toBe(`/studio/track?id=${TRACK_ID}`);
  });

  it('reads an upper-case scheme and host as the same origin', () => {
    expect(
      parseStudioShareLink(
        `HTTPS://QUEERPULSE.TEST/studio/track?id=${TRACK_ID}`,
        ORIGINS,
      )?.kind,
    ).toBe('track');
  });

  it('normalises configured origins and skips one that does not parse', () => {
    expect(
      parseStudioShareLink(TRACK_URL, ['not a url', 'https://QueerPulse.test/'])
        ?.kind,
    ).toBe('track');
  });

  it.each([
    ['a missing id', 'https://queerpulse.test/studio/track'],
    ['an empty id', 'https://queerpulse.test/studio/track?id='],
    ['a short id', 'https://queerpulse.test/studio/track?id=0f8a3c2e'],
    ['a non-uuid id', 'https://queerpulse.test/studio/track?id=not-a-uuid'],
    [
      'an id with a tail',
      `https://queerpulse.test/studio/track?id=${TRACK_ID}0`,
    ],
  ])('rejects %s', (_label, url) => {
    expect(parseStudioShareLink(url, ORIGINS)).toBeNull();
  });

  it.each([
    [
      'a preview link',
      `https://queerpulse.test/studio/preview/${'b'.repeat(43)}`,
    ],
    ['a relative preview link', `/studio/preview/${'b'.repeat(43)}`],
    [
      'a preview path with an id',
      `https://queerpulse.test/studio/preview?id=${TRACK_ID}`,
    ],
    ['an artist page', `https://queerpulse.test/studio/artist?id=${TRACK_ID}`],
    ['a scene', 'https://queerpulse.test/studio/scene?slug=lisbon-house'],
    [
      'a deeper track path',
      `https://queerpulse.test/studio/track/extra?id=${TRACK_ID}`,
    ],
    [
      'a trailing slash',
      `https://queerpulse.test/studio/track/?id=${TRACK_ID}`,
    ],
    ['the Studio home', 'https://queerpulse.test/studio'],
  ])('rejects %s', (_label, url) => {
    expect(parseStudioShareLink(url, ORIGINS)).toBeNull();
  });

  it('rejects a lookalike host, userinfo, another port and another scheme', () => {
    for (const url of [
      `https://queerpulse.test.evil.example/studio/track?id=${TRACK_ID}`,
      `https://queerpulse.test@evil.example/studio/track?id=${TRACK_ID}`,
      `https://member@queerpulse.test/studio/track?id=${TRACK_ID}`,
      `https://member:pw@queerpulse.test/studio/track?id=${TRACK_ID}`,
      `https://queerpulse.test:8443/studio/track?id=${TRACK_ID}`,
      `http://queerpulse.test/studio/track?id=${TRACK_ID}`,
      `https://elsewhere.example/studio/track?id=${TRACK_ID}`,
    ]) {
      expect(parseStudioShareLink(url, ORIGINS)).toBeNull();
    }
  });

  it('keeps t as whole seconds from 0 to the one-day cap', () => {
    expect(parseStudioShareLink(`${TRACK_URL}&t=0`, ORIGINS)).toEqual({
      kind: 'track',
      id: TRACK_ID,
      startAtSeconds: 0,
      path: `/studio/track?id=${TRACK_ID}&t=0`,
    });
    expect(
      parseStudioShareLink(
        `${TRACK_URL}&t=${STUDIO_SHARE_MAX_START_SECONDS}`,
        ORIGINS,
      )?.startAtSeconds,
    ).toBe(86_400);
  });

  it.each(['86401', '-5', '1.5', 'abc', '', '1e3', '+5'])(
    'ignores t=%s and still parses the link',
    (rawSeconds) => {
      const link = parseStudioShareLink(
        `${TRACK_URL}&t=${rawSeconds}`,
        ORIGINS,
      );
      expect(link?.startAtSeconds).toBeNull();
      expect(link?.path).toBe(`/studio/track?id=${TRACK_ID}`);
    },
  );

  it('ignores t on a release link', () => {
    const link = parseStudioShareLink(
      `https://queerpulse.test/studio/album?id=${TRACK_ID}&t=30`,
      ORIGINS,
    );
    expect(link?.startAtSeconds).toBeNull();
    expect(link?.path).toBe(`/studio/album?id=${TRACK_ID}`);
  });

  it('ignores extra params and the fragment', () => {
    expect(
      parseStudioShareLink(
        `https://queerpulse.test/studio/track?utm=feed&id=${TRACK_ID}&t=12#lyrics`,
        ORIGINS,
      )?.path,
    ).toBe(`/studio/track?id=${TRACK_ID}&t=12`);
  });
});

// Lyric links (PRD-13). `queerpulse/src/features/studio/share/
// studioLyricLinkParity.test.ts` holds this same table, row for row: the
// query typed after the track id, the line and start both readers take, and
// the canonical path both build. Change a row here and there together.
const LYRIC_PARITY_ROWS: readonly {
  query: string;
  lineIndex: number | null;
  startAtSeconds: number | null;
  path: string;
}[] = [
  {
    query: '&line=7&t=42',
    lineIndex: 7,
    startAtSeconds: 42,
    path: '&t=42&line=7',
  },
  { query: '&line=0', lineIndex: 0, startAtSeconds: null, path: '&line=0' },
  {
    query: '&t=5&line=499',
    lineIndex: 499,
    startAtSeconds: 5,
    path: '&t=5&line=499',
  },
  { query: '&line=007', lineIndex: 7, startAtSeconds: null, path: '&line=7' },
  {
    query: '&line=3&line=5',
    lineIndex: 3,
    startAtSeconds: null,
    path: '&line=3',
  },
  { query: '&t=5&line=500', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
  { query: '&t=5&line=1000', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
  { query: '&t=5&line=-1', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
  { query: '&t=5&line=1.5', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
  { query: '&t=5&line=abc', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
  { query: '&t=5&line=', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
  { query: '&t=5&line=+3', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
  { query: '&t=5&line=1e2', lineIndex: null, startAtSeconds: 5, path: '&t=5' },
];

describe('lyric link parity rows', () => {
  it('caps the line at 499', () => {
    expect(STUDIO_SHARE_MAX_LINE_INDEX).toBe(499);
  });

  it.each(LYRIC_PARITY_ROWS)(
    'reads $query as the frontend does',
    ({ query, lineIndex, startAtSeconds, path }) => {
      const link = parseStudioShareLink(`${TRACK_URL}${query}`, ORIGINS);
      expect(link?.kind).toBe('track');
      expect(link?.id).toBe(TRACK_ID);
      expect(link?.startAtSeconds).toBe(startAtSeconds);
      expect(link?.lineIndex ?? null).toBe(lineIndex);
      expect(link?.path).toBe(`/studio/track?id=${TRACK_ID}${path}`);
    },
  );
});

describe('parseStudioShareLink lyric lines', () => {
  it('reads line on a track link and keeps it in the canonical path', () => {
    expect(parseStudioShareLink(`${TRACK_URL}&line=7&t=42`, ORIGINS)).toEqual({
      kind: 'track',
      id: TRACK_ID,
      startAtSeconds: 42,
      lineIndex: 7,
      path: `/studio/track?id=${TRACK_ID}&t=42&line=7`,
    });
  });

  it('reads line without t', () => {
    expect(parseStudioShareLink(`${TRACK_URL}&line=0`, ORIGINS)?.path).toBe(
      `/studio/track?id=${TRACK_ID}&line=0`,
    );
  });

  it.each(['500', '1000', '-1', '1.5', 'abc', '', '+3', '1e2'])(
    'ignores line=%s and still parses the track link',
    (rawLine) => {
      const link = parseStudioShareLink(
        `${TRACK_URL}&t=5&line=${rawLine}`,
        ORIGINS,
      );
      expect(link?.lineIndex).toBeUndefined();
      expect(link?.path).toBe(`/studio/track?id=${TRACK_ID}&t=5`);
    },
  );

  it('ignores line on a release link', () => {
    const link = parseStudioShareLink(
      `https://queerpulse.test/studio/album?id=${TRACK_ID}&line=3`,
      ORIGINS,
    );
    expect(link?.lineIndex).toBeUndefined();
    expect(link?.path).toBe(`/studio/album?id=${TRACK_ID}`);
  });

  it('takes a lyric link out of a note like any track link', () => {
    const body = `this line (${TRACK_URL}&t=42&line=7) tonight`;
    const match = findStudioShareLinkMatch(body, ORIGINS);
    expect(match?.url).toBe(`${TRACK_URL}&t=42&line=7`);
    expect(match && textWithoutStudioShareLink(body, match)).toBe(
      'this line tonight',
    );
  });
});

describe('findStudioShareLinkMatch', () => {
  it('finds a link inside a sentence and reports where it starts', () => {
    const text = `this one is for you ${TRACK_URL} see you Saturday`;
    const match = findStudioShareLinkMatch(text, ORIGINS);
    expect(match?.link.kind).toBe('track');
    expect(match?.url).toBe(TRACK_URL);
    expect(match?.index).toBe(text.indexOf(TRACK_URL));
  });

  it.each([
    `listen: ${TRACK_URL}.`,
    `(${TRACK_URL})`,
    `"${TRACK_URL}"`,
    `${TRACK_URL}!?`,
    `[${TRACK_URL}],`,
    `<${TRACK_URL}>`,
    `look <${TRACK_URL}> here`,
    `ouve isto «${TRACK_URL}»`,
  ])('trims trailing punctuation and closing brackets in %s', (text) => {
    expect(findStudioShareLinkMatch(text, ORIGINS)?.url).toBe(TRACK_URL);
  });

  it('lets the first Studio link win', () => {
    const text = `${TRACK_URL} and https://queerpulse.test/studio/album?id=${OTHER_ID}`;
    expect(findStudioShareLink(text, ORIGINS)?.id).toBe(TRACK_ID);
  });

  it('skips links that do not parse and takes the first one that does', () => {
    const text = [
      'https://example.com/page',
      `https://queerpulse.test/studio/preview/${'b'.repeat(43)}`,
      `https://queerpulse.test/studio/album?id=${OTHER_ID}`,
    ].join(' ');
    expect(findStudioShareLink(text, ORIGINS)).toEqual({
      kind: 'release',
      id: OTHER_ID,
      startAtSeconds: null,
      path: `/studio/album?id=${OTHER_ID}`,
    });
  });

  it('finds a root-relative path after a line break', () => {
    expect(
      findStudioShareLink(`so good\n/studio/track?id=${TRACK_ID}`, ORIGINS)?.id,
    ).toBe(TRACK_ID);
  });

  it('ignores a Studio path glued to another host written without a scheme', () => {
    expect(
      findStudioShareLink(`example.com/studio/track?id=${TRACK_ID}`, ORIGINS),
    ).toBeNull();
  });

  it('answers null for text with no link', () => {
    expect(findStudioShareLinkMatch('', ORIGINS)).toBeNull();
    expect(
      findStudioShareLinkMatch('see you at the event', ORIGINS),
    ).toBeNull();
  });
});

describe('textWithoutStudioShareLink', () => {
  function noteOf(text: string): string {
    const match = findStudioShareLinkMatch(text, ORIGINS);
    if (!match) throw new Error('expected a Studio link in the fixture');
    return textWithoutStudioShareLink(text, match);
  }

  it('drops a link on its own line with the blank line it leaves', () => {
    expect(noteOf(`so good\n${TRACK_URL}\nsee you Saturday`)).toBe(
      'so good\nsee you Saturday',
    );
  });

  it('joins the two sides of a line with one space', () => {
    expect(noteOf(`try ${TRACK_URL} tonight`)).toBe('try tonight');
  });

  it('adds no space before closing punctuation', () => {
    expect(noteOf(`try ${TRACK_URL}, then call me`)).toBe('try, then call me');
  });

  it('returns an empty note for a link on its own', () => {
    expect(noteOf(`  ${TRACK_URL}  \n`)).toBe('');
  });

  it('returns an empty note when only brackets and punctuation are left', () => {
    expect(noteOf(`(${TRACK_URL}).`)).toBe('');
  });

  it.each([
    [`listen to this (${TRACK_URL}).`, 'listen to this.'],
    [`listen to this (${TRACK_URL})!`, 'listen to this!'],
    [`check "${TRACK_URL}" now`, 'check now'],
    [`(${TRACK_URL}) wow`, 'wow'],
    [`look <${TRACK_URL}> here`, 'look here'],
    [`ouve isto «${TRACK_URL}»`, 'ouve isto'],
  ])('drops the bracket or quote pair around the link in %s', (text, note) => {
    expect(noteOf(text)).toBe(note);
  });

  it('reads CRLF line breaks as LF', () => {
    expect(noteOf(`so good\r\n\r\n${TRACK_URL}\r\n\r\nsee you`)).toBe(
      'so good\n\nsee you',
    );
  });

  it('keeps one paragraph break when the link had a paragraph to itself', () => {
    expect(noteOf(`so good\n\n${TRACK_URL}\n\nsee you`)).toBe(
      'so good\n\nsee you',
    );
  });
});

describe('postTextWithoutStudioShareLink', () => {
  function postNoteOf(text: string): string {
    const match = findStudioShareLinkMatch(text, ORIGINS);
    if (!match) throw new Error('expected a Studio link in the fixture');
    return postTextWithoutStudioShareLink(text, match);
  }

  it('reads a markdown link to a Studio page as its label', () => {
    expect(postNoteOf(`listen to [the EP](${TRACK_URL}) tonight`)).toBe(
      'listen to the EP tonight',
    );
  });

  it('keeps the punctuation after a markdown link', () => {
    expect(postNoteOf(`listen to [the EP](${TRACK_URL}).`)).toBe(
      'listen to the EP.',
    );
  });

  it('returns an empty note for a markdown link with an empty label', () => {
    expect(postNoteOf(`[](${TRACK_URL})`)).toBe('');
  });

  it('joins the sides around an empty-label markdown link with one space', () => {
    expect(postNoteOf(`try [](${TRACK_URL}) tonight`)).toBe('try tonight');
  });

  it.each([
    `try ${TRACK_URL} tonight`,
    `so good\n\n${TRACK_URL}\n\nsee you`,
    `listen to this (${TRACK_URL}).`,
    `a [label\nacross lines](${TRACK_URL}) here`,
  ])(
    'reads every other match as textWithoutStudioShareLink does: %s',
    (text) => {
      const match = findStudioShareLinkMatch(text, ORIGINS);
      if (!match) throw new Error('expected a Studio link in the fixture');
      expect(postTextWithoutStudioShareLink(text, match)).toBe(
        textWithoutStudioShareLink(text, match),
      );
    },
  );

  it('leaves a bare link reading as before', () => {
    expect(postNoteOf(`try ${TRACK_URL} tonight`)).toBe('try tonight');
  });
});

describe('isOwnOriginStudioUrl', () => {
  it.each([
    TRACK_URL,
    `https://queerpulse.test/studio/preview/${'b'.repeat(43)}`,
    `https://queerpulse.test/studio/artist?id=${TRACK_ID}`,
    'https://queerpulse.test/studio',
    'https://www.queerpulse.test/studio/library',
    `https://queerpulse.test/Studio/album?id=${TRACK_ID}`,
    `https://queerpulse.test/%73tudio/collection?id=${TRACK_ID}`,
    `https://queerpulse.test/%2573tudio/track?id=${TRACK_ID}`,
    `https://queerpulse.test//studio/track?id=${TRACK_ID}`,
    `https://member@queerpulse.test/studio/track?id=${TRACK_ID}`,
  ])('answers true for %s', (url) => {
    expect(isOwnOriginStudioUrl(url, ORIGINS)).toBe(true);
  });

  it.each([
    `https://elsewhere.example/studio/track?id=${TRACK_ID}`,
    'https://queerpulse.test/events',
    'https://queerpulse.test/studio-guide',
    `/studio/track?id=${TRACK_ID}`,
    'not a url',
  ])('answers false for %s', (url) => {
    expect(isOwnOriginStudioUrl(url, ORIGINS)).toBe(false);
  });
});

describe('studioShareOrigins', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  it('reads the FRONTEND_URL allowlist at call time', () => {
    process.env.FRONTEND_URL =
      'https://queerpulse.test,https://www.queerpulse.test';
    expect(studioShareOrigins()).toEqual(
      expect.arrayContaining([
        'https://queerpulse.test',
        'https://www.queerpulse.test',
      ]),
    );
  });

  it('always holds both production origins, so a www link parses', () => {
    process.env.FRONTEND_URL = 'https://queerpulse.com';
    const origins = studioShareOrigins();
    expect(origins).toEqual(
      expect.arrayContaining([
        'https://queerpulse.com',
        'https://www.queerpulse.com',
      ]),
    );
    expect(new Set(origins).size).toBe(origins.length);
    expect(
      parseStudioShareLink(
        `https://www.queerpulse.com/studio/album?id=${TRACK_ID}`,
        origins,
      )?.kind,
    ).toBe('release');
  });
});

describe('isOwnOriginStudioUrl decode depth', () => {
  /** The `s` of `studio` percent-encoded `encodeCount` times over. */
  function studioPathEncoded(encodeCount: number): string {
    const encodedLetter = `%${'25'.repeat(encodeCount - 1)}73`;
    return `https://queerpulse.test/${encodedLetter}tudio/track?id=${TRACK_ID}`;
  }

  it('reads a path encoded five times, the depth the log redaction uses', () => {
    expect(isOwnOriginStudioUrl(studioPathEncoded(5), ORIGINS)).toBe(true);
  });

  it('stops after five decodes', () => {
    expect(isOwnOriginStudioUrl(studioPathEncoded(6), ORIGINS)).toBe(false);
  });
});
