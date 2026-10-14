import {
  dropStudioListeningReferer,
  dropStudioListeningUrl,
  isStudioListeningRequest,
  redactStudioPreviewToken,
} from './studio-request-log';

const trackId = '3f2b8c1e-5d4a-4b7e-9a10-6c2d8e4f1a22';
const playlistId = '7c1e2b3a-4d5e-4f60-8a71-9b2c3d4e5f60';
const entryId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const previewToken = 'f'.repeat(64);
const personaId = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

describe('isStudioListeningRequest', () => {
  it.each([
    `/studio/tracks/${trackId}`,
    `/studio/tracks/${trackId}/stream`,
    `/studio/tracks/${trackId}/playlists`,
    `/api/studio/tracks/${trackId}`,
    `/api/studio/tracks/${trackId}/stream?x=1`,
    `/Studio/Tracks/${trackId}/stream`,
    `/studio/playlists/${playlistId}`,
    `/studio/playlists/${playlistId}/tracks`,
    `/studio/playlists/${playlistId}/entries/${entryId}`,
    `/studio/playlists/${playlistId}/entry-order`,
    `/api/studio/playlists/${playlistId}?x=1`,
    `/STUDIO/PLAYLISTS/${playlistId}`,
    '/studio/playlists/mine',
    '/api/studio/playlists/mine?cursor=abc',
    '/studio/search',
    '/studio/search?q=noite',
    '/api/studio/search?q=ana%20silva&type=playlists',
    '/Studio/Search?Q=noite',
    '/studio/search/',
    'https://api.queerpulse.test/studio/search?q=noite',
    `/studio/previews/${previewToken}`,
    `/studio/previews/${previewToken}/tracks/${trackId}/stream`,
    `/api/studio/previews/${previewToken}?x=1`,
    `/STUDIO/PREVIEWS/${previewToken}`,
    '/studio/previews/not-a-token',
    `/studio/artists/${personaId}/press-kit`,
    `/api/studio/artists/${personaId}/press-kit?x=1`,
    `/Studio/Artists/${personaId}/Press-Kit`,
    `/studio/artists/${personaId}/press-kit/`,
    '/studio/radio',
    '/studio/radio?genre=electronic',
    '/api/studio/radio?mood=late-night',
    '/Studio/Radio/?Mood=tender',
    'https://api.queerpulse.test/studio/radio?genre=fado',
    `/studio/tracks/${trackId}/persona-credits`,
    `/studio/tracks/${trackId}/persona-credits/${entryId}`,
    `/studio/tracks/${trackId}/publish`,
    `/api/studio/tracks/${trackId}/publish`,
    '/studio/formats',
    '/studio/formats/',
    '/api/studio/formats?x=1',
    '/Studio/Formats',
    '/studio/episodes/latest',
    '/studio/episodes/latest?cursor=abc&limit=12',
    '/api/studio/episodes/latest',
    '/STUDIO/EPISODES/LATEST',
    '/studio/playlists/liked',
    '/api/studio/playlists/liked?cursor=abc',
    `/me/saved/studio_track%3A${trackId}`,
    `/me/saved/studio_track:${trackId}`,
    `/api/me/saved/studio_track%3a${trackId}`,
    `/me/saved/studio_release:${trackId}`,
    `/me/saved/studio_playlist%3A${playlistId}`,
    `/Me/Saved/Studio_Track:${trackId}`,
    `/me/saved/lists/${playlistId}/items/studio_track:${trackId}`,
    `/me/saved/lists/${playlistId}/items/studio_track%3A${trackId}`,
    `/api/me/saved/lists/${playlistId}/items/studio_release%3a${trackId}`,
    `/me/saved/lists/${playlistId}/items/studio_playlist:${entryId}`,
    `/Me/Saved/Lists/${playlistId}/Items/Studio_Track:${trackId}`,
  ])('matches %s', (url) => {
    expect(isStudioListeningRequest(url)).toBe(true);
  });

  it.each([
    '/studio/releases',
    '/studio/playlists',
    '/studio/playlists/',
    '/studio/playlistsx/1',
    '/studio/tracks',
    '/studio/tracks/',
    '/studio/tracksx/1',
    `/admin/studio/releases/${trackId}`,
    `/Admin/Studio/tracks/${trackId}`,
    `/admin/studio/playlists/${playlistId}`,
    '/studio/members/ana-silva/playlists',
    `/studio/artists/${trackId}/playlists`,
    '/studio/searchx?q=noite',
    '/studio/search/saved',
    '/admin/studio/search?q=noite',
    '/search?q=studio/search',
    '/studio/previews',
    '/studio/previews/',
    `/studio/artists/${personaId}`,
    `/studio/artists/${personaId}/press-kitx`,
    `/studio/artists/${personaId}/stats`,
    `/admin/studio/previews/${previewToken}`,
    `/admin/studio/artists/${personaId}/press-kit`,
    `/studio/releases/${trackId}/preview-link`,
    '/studio/radiox?genre=fado',
    '/studio/radio/saved',
    '/admin/studio/radio?genre=fado',
    '/studio/moods',
    '/studio/curation',
    '/studio/scenes/lisbon-ballroom',
    '/studio/credits/inbox',
    '/studio/credit-candidates/river-ink',
    `/studio/artists/${trackId}/appears-on`,
    `/studio/artists/${trackId}/related`,
    '',
    '/studio/formatsx',
    '/studio/formats/podcast',
    '/studio/episodes',
    '/studio/episodes/',
    '/admin/studio/formats',
    '/admin/studio/episodes/latest',
    '/me/saved',
    '/me/saved?kind=studio_track',
    '/api/me/saved?kind=studio_track',
    `/me/saved/article:${trackId}`,
    `/me/saved/lists/${playlistId}`,
    '/me/saved/lists',
    `/me/saved/lists/${playlistId}/share`,
    `/me/saved/lists/${playlistId}/items/article:${trackId}`,
    `/me/saved/lists/${playlistId}/items/event%3Alisbon-pride`,
  ])('ignores %s', (url) => {
    expect(isStudioListeningRequest(url)).toBe(false);
  });

  it('ignores an undefined url', () => {
    expect(isStudioListeningRequest(undefined)).toBe(false);
  });
});

describe('dropStudioListeningUrl', () => {
  it('removes the url and every query string shape from a Studio listening request', () => {
    const searchRequest = {
      url: 'https://api.queerpulse.test/studio/search?q=noite',
      query_string: 'q=noite',
      method: 'GET',
    };
    expect(dropStudioListeningUrl(searchRequest)).toBe(true);
    expect(searchRequest).toEqual({ method: 'GET' });

    const playlistRequest = {
      url: `/studio/playlists/${playlistId}`,
      query_string: [['cursor', 'abc']],
    };
    expect(dropStudioListeningUrl(playlistRequest)).toBe(true);
    expect(playlistRequest).toEqual({});
  });

  it('removes the url and query string of a radio request', () => {
    const radioRequest = {
      url: 'https://api.queerpulse.test/studio/radio?mood=late-night',
      query_string: 'mood=late-night',
    };
    expect(dropStudioListeningUrl(radioRequest)).toBe(true);
    expect(radioRequest).toEqual({});
  });

  it('keeps the url of every other request', () => {
    const releasesRequest = {
      url: '/studio/releases?genre=house',
      query_string: { genre: 'house' },
    };
    expect(dropStudioListeningUrl(releasesRequest)).toBe(false);
    expect(releasesRequest).toEqual({
      url: '/studio/releases?genre=house',
      query_string: { genre: 'house' },
    });

    const staffRequest = { url: `/admin/studio/playlists/${playlistId}` };
    expect(dropStudioListeningUrl(staffRequest)).toBe(false);
    expect(staffRequest.url).toBe(`/admin/studio/playlists/${playlistId}`);
  });

  it('answers false for an event with no request', () => {
    expect(dropStudioListeningUrl(undefined)).toBe(false);
  });
});

describe('dropStudioListeningReferer', () => {
  it('drops a frontend collection referer', () => {
    const request = {
      headers: {
        referer: `https://queerpulse.test/studio/collection?id=${playlistId}`,
        accept: 'application/json',
      },
    };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({ accept: 'application/json' });
  });

  it('drops a scene page referer, since the scene page plays music', () => {
    const request = {
      headers: {
        referer: 'https://queerpulse.test/studio/scene?slug=lisbon-ballroom',
      },
    };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it.each([
    `https://queerpulse.test/studio/preview/${previewToken}`,
    `https://queerpulse.test/studio/press?id=${personaId}`,
    `https://queerpulse.test/studio/press/print?id=${personaId}`,
    `https://queerpulse.test/studio/press/edit?persona=${personaId}`,
  ])('drops a preview or press kit page referer: %s', (referer) => {
    const request = { headers: { referer } };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('drops a liked songs page referer', () => {
    const request = {
      headers: { referer: 'https://queerpulse.test/studio/liked' },
    };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('keeps the referer of an unrelated page', () => {
    const request = { headers: { referer: 'https://queerpulse.test/feed' } };
    expect(dropStudioListeningReferer(request)).toBe(false);
    expect(request.headers.referer).toBe('https://queerpulse.test/feed');
  });

  it('handles an upper-case Referer key', () => {
    const request = {
      headers: { Referer: 'https://queerpulse.test/studio/search?q=noite' },
    };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('drops an API listening path referer', () => {
    const request = {
      headers: { referer: `/api/studio/playlists/${playlistId}` },
    };
    expect(dropStudioListeningReferer(request)).toBe(true);
  });

  it('drops a referer that cannot be parsed', () => {
    const request = { headers: { referer: 'http://[bad' } };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });
});

describe('redactStudioPreviewToken', () => {
  it('hides the token on the preview stream path', () => {
    expect(
      redactStudioPreviewToken(
        `/studio/previews/${previewToken}/tracks/${trackId}/stream`,
      ),
    ).toBe(`/studio/previews/[token]/tracks/${trackId}/stream`);
  });

  it('hides the token on the preview read path', () => {
    expect(redactStudioPreviewToken(`/studio/previews/${previewToken}`)).toBe(
      '/studio/previews/[token]',
    );
    expect(
      redactStudioPreviewToken(`/api/Studio/Previews/${previewToken}/`),
    ).toBe('/api/Studio/Previews/[token]/');
  });

  it('keeps the query string as it arrived', () => {
    expect(
      redactStudioPreviewToken(`/studio/previews/${previewToken}?quality=high`),
    ).toBe('/studio/previews/[token]?quality=high');
  });

  it('leaves a token-shaped query value alone outside the preview path', () => {
    const url = `/studio/releases?previews/${previewToken}`;
    expect(redactStudioPreviewToken(url)).toBe(url);
  });

  it.each([
    `/studio/tracks/${trackId}/stream`,
    `/studio/releases/${trackId}/preview-link`,
    '/studio/previews',
    '/feed?cursor=abc',
    '/auth/google?invite=abc',
  ])('leaves other urls untouched: %s', (url) => {
    expect(redactStudioPreviewToken(url)).toBe(url);
  });

  it('passes undefined through', () => {
    expect(redactStudioPreviewToken(undefined)).toBeUndefined();
  });
});
