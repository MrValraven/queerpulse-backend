import { isStudioTrackRequest } from './studio-request-log';

const trackId = '3f2b8c1e-5d4a-4b7e-9a10-6c2d8e4f1a22';

describe('isStudioTrackRequest', () => {
  it.each([
    `/studio/tracks/${trackId}`,
    `/studio/tracks/${trackId}/stream`,
    `/api/studio/tracks/${trackId}`,
    `/api/studio/tracks/${trackId}/stream`,
    `/studio/tracks/${trackId}?x=1`,
    `/api/studio/tracks/${trackId}/stream?x=1`,
    `/Studio/Tracks/${trackId}/stream`,
  ])('matches %s', (url) => {
    expect(isStudioTrackRequest(url)).toBe(true);
  });

  it.each([
    '/studio/releases',
    `/admin/studio/releases/${trackId}`,
    `/Admin/Studio/tracks/${trackId}`,
    '/studio/tracksx/1',
    '/studio/tracks',
    '/studio/tracks/',
    '',
  ])('ignores %s', (url) => {
    expect(isStudioTrackRequest(url)).toBe(false);
  });

  it('ignores an undefined url', () => {
    expect(isStudioTrackRequest(undefined)).toBe(false);
  });
});
