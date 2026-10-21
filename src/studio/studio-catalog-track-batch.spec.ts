import { HttpStatus, NotFoundException } from '@nestjs/common';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioTrackResponse } from './studio-response';
import { studioSafetyError } from './studio-safety.constants';
import { studioError } from './studio.constants';

const VIEWER_ID = 'c7000000-0000-4000-8000-000000000001';

const trackOf = (id: string) => ({ id }) as unknown as StudioTrackResponse;

describe('StudioCatalogService.getTracks', () => {
  let service: StudioCatalogService;
  let getTrack: jest.SpyInstance;

  beforeEach(() => {
    // Only the batch logic is under test: every id goes through the single
    // read, which `studio-catalog.service.spec.ts` covers rule by rule.
    service = Object.create(
      StudioCatalogService.prototype,
    ) as StudioCatalogService;
    getTrack = jest
      .spyOn(service, 'getTrack')
      .mockImplementation((_viewerId: string, trackId: string) =>
        Promise.resolve(trackOf(trackId)),
      );
  });

  it('runs the single read for every id and answers in request order', async () => {
    const result = await service.getTracks(VIEWER_ID, ['b', 'a', 'c']);
    expect(result.items.map((track) => track.id)).toEqual(['b', 'a', 'c']);
    expect(getTrack).toHaveBeenCalledTimes(3);
    expect(getTrack).toHaveBeenCalledWith(VIEWER_ID, 'a');
  });

  it('leaves out a track the single read answers 404 or 410 for', async () => {
    getTrack.mockImplementation((_viewerId: string, trackId: string) => {
      if (trackId === 'gone') return Promise.reject(new NotFoundException());
      if (trackId === 'held') {
        return Promise.reject(studioSafetyError('studio_track_withheld'));
      }
      if (trackId === 'withdrawn') {
        return Promise.reject(studioError('studio_release_withdrawn'));
      }
      return Promise.resolve(trackOf(trackId));
    });
    const result = await service.getTracks(VIEWER_ID, [
      'gone',
      'kept',
      'held',
      'withdrawn',
    ]);
    expect(result.items.map((track) => track.id)).toEqual(['kept']);
  });

  it('fails the batch on any other failure', async () => {
    const failure = new Error('connection terminated');
    getTrack.mockRejectedValueOnce(failure);
    await expect(service.getTracks(VIEWER_ID, ['a', 'b'])).rejects.toBe(
      failure,
    );
  });

  it('skips exactly the not found and gone answers', () => {
    expect(studioSafetyError('studio_track_withheld').getStatus()).toBe(
      HttpStatus.GONE,
    );
    expect(studioError('studio_release_withdrawn').getStatus()).toBe(
      HttpStatus.GONE,
    );
  });
});
