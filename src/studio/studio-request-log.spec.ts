import {
  dropStudioListeningReferer,
  dropStudioListeningUrl,
  isStudioListeningRequest,
} from './studio-request-log';

const trackId = '3f2b8c1e-5d4a-4b7e-9a10-6c2d8e4f1a22';
const playlistId = '7c1e2b3a-4d5e-4f60-8a71-9b2c3d4e5f60';
const entryId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

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
    '',
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
