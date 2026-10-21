import {
  GUARDS_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPlaylistFoldersController } from './studio-playlist-folders.controller';
import { StudioPlaylistFoldersService } from './studio-playlist-folders.service';
import { StudioPlaylistsController } from './studio-playlists.controller';
import { isStudioListeningRequest } from './studio-request-log';
import { StudioModule } from './studio.module';

const routePathOf = (methodName: keyof StudioPlaylistFoldersController) =>
  Reflect.getMetadata(
    PATH_METADATA,
    StudioPlaylistFoldersController.prototype[methodName],
  ) as unknown;

describe('StudioPlaylistFoldersController', () => {
  it('is guarded like the playlists controller and tagged with the studio feature', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, StudioPlaylistFoldersController),
    ).toEqual([ActiveMemberGuard, StudioAccessGuard]);
    expect(
      Reflect.getMetadata(FEATURE_KEY, StudioPlaylistFoldersController),
    ).toBe('studio');
  });

  it('serves every route under studio/playlists', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, StudioPlaylistFoldersController),
    ).toBe('studio/playlists');
    expect(routePathOf('list')).toBe('folders');
    expect(routePathOf('create')).toBe('folders');
    expect(routePathOf('update')).toBe('folders/:folderId');
    expect(routePathOf('remove')).toBe('folders/:folderId');
    expect(routePathOf('movePlaylist')).toBe(':id/folder');
  });

  it('is registered before the playlists controller, so GET folders never meets the :id uuid pipe', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      StudioModule,
    ) as unknown[];
    expect(
      controllers.indexOf(StudioPlaylistFoldersController),
    ).toBeGreaterThan(-1);
    expect(controllers.indexOf(StudioPlaylistFoldersController)).toBeLessThan(
      controllers.indexOf(StudioPlaylistsController),
    );
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(expect.arrayContaining([StudioPlaylistFoldersService]));
  });

  it('keeps every folder path out of the request log', () => {
    for (const [url, method] of [
      ['/studio/playlists/folders', 'GET'],
      ['/studio/playlists/folders', 'POST'],
      ['/studio/playlists/folders/0b7c', 'PATCH'],
      ['/studio/playlists/folders/0b7c', 'DELETE'],
      ['/studio/playlists/9a1d/folder', 'PUT'],
    ])
      expect(isStudioListeningRequest(url, method)).toBe(true);
  });

  it('passes the caller and the folder id through to the service', async () => {
    const service = {
      list: jest.fn().mockResolvedValue({ items: [] }),
      movePlaylist: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new StudioPlaylistFoldersController(
      service as unknown as StudioPlaylistFoldersService,
    );
    const user = { userId: 'member-1' } as Parameters<
      StudioPlaylistFoldersController['list']
    >[0];
    await controller.list(user);
    await controller.movePlaylist(user, 'playlist-a', { folderId: null });
    expect(service.list).toHaveBeenCalledWith('member-1');
    expect(service.movePlaylist).toHaveBeenCalledWith(
      'member-1',
      'playlist-a',
      null,
    );
  });
});
