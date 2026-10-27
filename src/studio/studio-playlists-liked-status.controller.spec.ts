import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { StudioLikedTracksService } from './studio-liked-tracks.service';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { StudioPlaylistWritesService } from './studio-playlist-writes.service';
import { StudioPlaylistsController } from './studio-playlists.controller';

const VIEWER = { userId: 'viewer-1' } as CurrentUserData;
const TRACK_A = 'b1000000-0000-4000-8000-000000000001';
const TRACK_B = 'b1000000-0000-4000-8000-000000000002';

describe('StudioPlaylistsController liked status', () => {
  let likedTracks: { likedAmong: jest.Mock };
  let controller: StudioPlaylistsController;

  beforeEach(() => {
    likedTracks = {
      likedAmong: jest.fn().mockResolvedValue({ likedTrackIds: [TRACK_A] }),
    };
    controller = new StudioPlaylistsController(
      {} as unknown as StudioPlaylistReadsService,
      {} as unknown as StudioPlaylistWritesService,
      likedTracks as unknown as StudioLikedTracksService,
    );
  });

  it('asks for the caller own likes among the named ids and nobody else', async () => {
    await expect(
      controller.likedStatus(VIEWER, { ids: [TRACK_A, TRACK_B] }),
    ).resolves.toEqual({ likedTrackIds: [TRACK_A] });
    expect(likedTracks.likedAmong).toHaveBeenCalledWith('viewer-1', [
      TRACK_A,
      TRACK_B,
    ]);
  });
});
