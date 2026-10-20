import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { END_EDITING_BETWEEN_MEMBERS_SQL } from './studio-playlist-editor-endings';
import { StudioPlaylistEditorBlockListener } from './studio-playlist-editor-block.listener';

describe('StudioPlaylistEditorBlockListener', () => {
  let query: jest.Mock;
  let listener: StudioPlaylistEditorBlockListener;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    listener = new StudioPlaylistEditorBlockListener({
      manager: { query },
    } as unknown as DataSource);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('ends the seats between the pair in one statement that covers both directions', async () => {
    await listener.handleMemberBlocked({
      blockerId: 'owner-1',
      blockedId: 'editor-1',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(END_EDITING_BETWEEN_MEMBERS_SQL, [
      'owner-1',
      'editor-1',
    ]);
  });

  it('ignores a malformed event and a self block', async () => {
    await listener.handleMemberBlocked({ blockerId: '', blockedId: 'x' });
    await listener.handleMemberBlocked({
      blockerId: 'owner-1',
      blockedId: 'owner-1',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('logs a failure and swallows it, since the block already committed', async () => {
    query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      listener.handleMemberBlocked({
        blockerId: 'owner-1',
        blockedId: 'editor-1',
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
