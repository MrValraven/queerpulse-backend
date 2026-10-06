import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumCoAuthorBlockListener } from './forum-co-author-block.listener';

/**
 * PRD-408. A block drops the co-author credit between the pair in both
 * directions. Each direction is its own UPDATE with a single where object: the
 * app runs TypeORM with `invalidWhereValuesBehavior`, which throws on an array
 * criteria, so a combined call would clear nothing.
 */
describe('ForumCoAuthorBlockListener', () => {
  let listener: ForumCoAuthorBlockListener;
  let threads: { update: jest.Mock };
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    threads = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ForumCoAuthorBlockListener,
        { provide: getRepositoryToken(ForumThread), useValue: threads },
      ],
    }).compile();

    listener = moduleRef.get(ForumCoAuthorBlockListener);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('clears the credit in each direction with one single-object update apiece', async () => {
    await listener.handleMemberBlocked({
      blockerId: 'author-1',
      blockedId: 'bea-1',
    });

    expect(threads.update).toHaveBeenCalledTimes(2);
    expect(threads.update).toHaveBeenNthCalledWith(
      1,
      { authorId: 'author-1', coAuthorId: 'bea-1' },
      { coAuthorId: null },
    );
    expect(threads.update).toHaveBeenNthCalledWith(
      2,
      { authorId: 'bea-1', coAuthorId: 'author-1' },
      { coAuthorId: null },
    );
    for (const [criteria] of threads.update.mock.calls as [unknown][]) {
      expect(Array.isArray(criteria)).toBe(false);
    }
  });

  it('clears the credit when the co-author is the one who blocks', async () => {
    await listener.handleMemberBlocked({
      blockerId: 'bea-1',
      blockedId: 'author-1',
    });

    expect(threads.update).toHaveBeenCalledWith(
      { authorId: 'author-1', coAuthorId: 'bea-1' },
      { coAuthorId: null },
    );
  });

  it('logs a failed direction and still runs the other one', async () => {
    threads.update
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ affected: 1 });

    await expect(
      listener.handleMemberBlocked({
        blockerId: 'author-1',
        blockedId: 'bea-1',
      }),
    ).resolves.toBeUndefined();

    expect(threads.update).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection reset'),
    );
  });

  it('ignores a self-block', async () => {
    await listener.handleMemberBlocked({
      blockerId: 'bea-1',
      blockedId: 'bea-1',
    });

    expect(threads.update).not.toHaveBeenCalled();
  });
});
