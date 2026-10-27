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
const milestoneId = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';

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
    `/studio/artists/${personaId}/stats`,
    `/studio/artists/${personaId}/placements`,
    `/studio/artists/${personaId}/placements?cursor=abc`,
    `/api/studio/artists/${personaId}/milestones`,
    `/Studio/Artists/${personaId}/Milestones/`,
    `/studio/milestones/${milestoneId}`,
    `/api/studio/milestones/${milestoneId}?x=1`,
    '/studio/milestones/not-a-uuid',
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
    '/studio/plays',
    '/v1/studio/plays/',
    '/Studio/Plays?x=1',
    '/me/studio-listening',
    '/me/studio-listening?range=6m',
    '/v1/me/studio-listening/recent?cursor=abc',
    '/me/studio-listening/supporting',
    `/studio/artists/${personaId}/plays?days=28`,
    `/studio/artists/${personaId}/supporter`,
    `/studio/artists/${personaId}/supporters`,
    `/me/saved/lists/${playlistId}/items/studio_playlist:${entryId}`,
    `/Me/Saved/Lists/${playlistId}/Items/Studio_Track:${trackId}`,
  ])('matches %s', (url) => {
    expect(isStudioListeningRequest(url)).toBe(true);
  });

  it.each([
    '/studio/playsx',
    '/studio/plays/extra',
    '/me/studio-listeningx',
    '/me/studio-playback',
    `/studio/artists/${personaId}/supportersx`,
    `/studio/artists/${personaId}/playsx`,
    `/admin/studio/artists/${personaId}/supporters`,
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
    `/studio/artists/${personaId}/statsx`,
    `/studio/artists/${personaId}/placementsx`,
    '/studio/milestones',
    '/studio/milestones/',
    `/studio/milestonesx/${milestoneId}`,
    `/admin/studio/artists/${personaId}/stats`,
    `/admin/studio/milestones/${milestoneId}`,
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

  it.each(['GET', 'OPTIONS', 'HEAD', 'POST', 'PUT', 'DELETE', undefined])(
    'skips the listening routes for method %s',
    (method) => {
      for (const url of [
        '/studio/plays',
        '/me/studio-listening',
        '/me/studio-listening/recent',
        `/studio/artists/${personaId}/supporter`,
        `/studio/artists/${personaId}/plays`,
      ]) {
        expect(isStudioListeningRequest(url, method)).toBe(true);
      }
    },
  );

  it('drops a Your listening page referer', () => {
    const request = {
      headers: { referer: 'https://queerpulse.test/studio/listening' },
    };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('ignores an undefined url', () => {
    expect(isStudioListeningRequest(undefined)).toBe(false);
  });

  it.each([
    [`/studio/releases/${trackId}`, 'GET'],
    [`/studio/releases/${trackId}/`, 'GET'],
    [`/api/studio/releases/${trackId}?x=1`, 'GET'],
    [`/Studio/Releases/${trackId}`, 'get'],
    [`/studio/releases/${trackId}`, 'HEAD'],
    [`/studio/releases/${trackId}`, undefined],
    ['https://api.queerpulse.test/studio/releases/not-a-uuid', 'GET'],
  ])('matches the release read %s with method %s', (url, method) => {
    expect(isStudioListeningRequest(url, method)).toBe(true);
  });

  it.each([
    [`/studio/releases/${trackId}`, 'PATCH'],
    [`/studio/releases/${trackId}`, 'DELETE'],
    [`/studio/releases/${trackId}/preview-link`, 'GET'],
    [`/studio/releases/${trackId}/preview-link`, 'POST'],
    [`/studio/releases/${trackId}/preview-link`, undefined],
    [`/studio/releases/${trackId}/schedule`, 'POST'],
    [`/studio/releases/${trackId}/publish`, 'POST'],
    [`/studio/releases/${trackId}/tracks`, 'POST'],
    [`/studio/releases/${trackId}/reminder`, 'PUT'],
    ['/studio/releases', 'GET'],
    ['/studio/releases/', 'GET'],
    ['/studio/releases?genre=house', 'GET'],
    [`/admin/studio/releases/${trackId}`, 'GET'],
  ])('logs the release route %s with method %s', (url, method) => {
    expect(isStudioListeningRequest(url, method)).toBe(false);
  });
});

it.each(['GET', 'OPTIONS', 'HEAD', 'POST', undefined])(
  'skips the dashboard reads and the milestone card for method %s',
  (method) => {
    expect(
      isStudioListeningRequest(
        `/studio/artists/${personaId}/placements`,
        method,
      ),
    ).toBe(true);
    expect(
      isStudioListeningRequest(`/studio/milestones/${milestoneId}`, method),
    ).toBe(true);
  },
);

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

  it('removes the request body of a listening request and keeps it elsewhere', () => {
    const playRequest = {
      url: '/studio/plays',
      method: 'POST',
      data: { trackId },
    };
    expect(dropStudioListeningUrl(playRequest)).toBe(true);
    expect(playRequest).toEqual({ method: 'POST' });

    const supporterRequest = {
      url: `/studio/artists/${personaId}/supporter`,
      method: 'PUT',
      data: '{"shownAsSubprofileId":"x"}',
    };
    expect(dropStudioListeningUrl(supporterRequest)).toBe(true);
    expect(supporterRequest).toEqual({ method: 'PUT' });

    const otherRequest = {
      url: '/studio/releases?genre=house',
      method: 'POST',
      data: { title: 'x' },
    };
    expect(dropStudioListeningUrl(otherRequest)).toBe(false);
    expect(otherRequest.data).toEqual({ title: 'x' });
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

  it('removes the url of a release read and keeps the url of a release edit', () => {
    const releaseRead = {
      url: `https://api.queerpulse.test/studio/releases/${trackId}`,
      query_string: '',
      method: 'GET',
    };
    expect(dropStudioListeningUrl(releaseRead)).toBe(true);
    expect(releaseRead).toEqual({ method: 'GET' });

    const releaseEdit = {
      url: `/studio/releases/${trackId}`,
      method: 'PATCH',
    };
    expect(dropStudioListeningUrl(releaseEdit)).toBe(false);
    expect(releaseEdit.url).toBe(`/studio/releases/${trackId}`);
  });

  it('answers false for an event with no request', () => {
    expect(dropStudioListeningUrl(undefined)).toBe(false);
  });
});

describe('dropStudioListeningReferer', () => {
  it('drops a milestone share link referer, which names an artist page', () => {
    const request = {
      headers: {
        referer: `https://queerpulse.test/studio/artist?id=${personaId}&milestone=${milestoneId}`,
      },
    };
    expect(dropStudioListeningReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

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
