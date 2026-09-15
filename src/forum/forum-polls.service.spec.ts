import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ForumPollOption } from './entities/forum-poll-option.entity';
import { ForumPollVote } from './entities/forum-poll-vote.entity';
import { ForumPoll } from './entities/forum-poll.entity';
import { ForumPollsService } from './forum-polls.service';

const voter: CurrentUserData = {
  userId: 'voter-1',
  email: 'v@example.com',
  status: 'active',
  role: 'member',
};

function makeOption(
  id: string,
  position: number,
  voteCount = 0,
): ForumPollOption {
  return { id, pollId: 'poll-1', label: `Option ${id}`, position, voteCount };
}

function makeVote(optionId: string): ForumPollVote {
  return {
    id: `vote-${optionId}`,
    pollId: 'poll-1',
    optionId,
    userId: voter.userId,
    createdAt: new Date('2026-09-01T10:00:00Z'),
  };
}

/**
 * Minimal fakes for the three repositories/managers `vote` touches. The
 * transaction manager runs its callback synchronously and records every write,
 * so the specs can assert on exactly which options were incremented and which
 * ballots were deleted — which is the whole `vote_count`-in-step contract.
 */
function build(
  options: {
    poll?: Partial<ForumPoll>;
    pollOptions?: ForumPollOption[];
    existingVotes?: ForumPollVote[];
    /** Rows the `orIgnore` insert reports back; empty = lost the unique race. */
    insertedRows?: unknown[];
  } = {},
) {
  const poll: ForumPoll = {
    id: 'poll-1',
    threadId: 't1',
    allowMultiple: false,
    closesAt: null,
    createdAt: new Date('2026-09-01T09:00:00Z'),
    ...options.poll,
  };
  const pollOptions = options.pollOptions ?? [
    makeOption('a', 0),
    makeOption('b', 1),
    makeOption('c', 2),
  ];
  const existingVotes = options.existingVotes ?? [];

  const managerDelete = jest.fn().mockResolvedValue({ affected: 1 });
  const managerIncrement = jest.fn().mockResolvedValue(undefined);
  const managerDecrement = jest.fn().mockResolvedValue(undefined);
  const insertedValues: unknown[] = [];
  const manager = {
    find: jest.fn().mockImplementation((entity: unknown) => {
      if (entity === ForumPollVote) return Promise.resolve(existingVotes);
      return Promise.resolve(pollOptions);
    }),
    delete: managerDelete,
    increment: managerIncrement,
    decrement: managerDecrement,
    createQueryBuilder: jest.fn(() => ({
      insert: () => ({
        into: () => ({
          values: (row: unknown) => {
            insertedValues.push(row);
            return {
              orIgnore: () => ({
                execute: () =>
                  Promise.resolve({ raw: options.insertedRows ?? [{}] }),
              }),
            };
          },
        }),
      }),
    })),
  };

  const polls = {
    findOne: jest.fn().mockResolvedValue(poll),
    manager: {
      transaction: jest.fn(
        async (callback: (m: typeof manager) => Promise<unknown>) =>
          callback(manager),
      ),
    },
  };
  const optionsRepo = { find: jest.fn().mockResolvedValue(pollOptions) };
  const threadsService = {
    loadOr404: jest.fn().mockResolvedValue({ id: 't1', communityId: null }),
    assertCanReplyInThread: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ForumPollsService(
    polls as never,
    optionsRepo as never,
    threadsService as never,
  );
  return {
    service,
    polls,
    optionsRepo,
    threadsService,
    manager,
    managerDelete,
    managerIncrement,
    managerDecrement,
    insertedValues,
  };
}

describe('ForumPollsService.vote — the ballot rules', () => {
  it('reuses the thread visibility gate rather than restating it', async () => {
    const { service, threadsService } = build();
    await service.vote('hello-world', voter, ['a']);
    expect(threadsService.loadOr404).toHaveBeenCalledWith(
      'hello-world',
      voter.userId,
      // A member is not a moderator, so nothing bypasses the
      // scheduled/under-review gate for them.
      { includeUnpublished: false },
    );
    // And a community thread still takes writes from its roster only.
    expect(threadsService.assertCanReplyInThread).toHaveBeenCalled();
  });

  it('404s a thread that carries no poll', async () => {
    const { service, polls } = build();
    polls.findOne.mockResolvedValue(null);
    await expect(
      service.vote('hello-world', voter, ['a']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a single-choice poll takes exactly one option', async () => {
    const { service } = build();
    await expect(
      service.vote('hello-world', voter, ['a', 'b']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a multi-choice poll takes one option', async () => {
    const { service, managerIncrement } = build({
      poll: { allowMultiple: true },
    });
    await service.vote('hello-world', voter, ['b']);
    expect(managerIncrement).toHaveBeenCalledTimes(1);
    expect(managerIncrement).toHaveBeenCalledWith(
      ForumPollOption,
      { id: 'b' },
      'voteCount',
      1,
    );
  });

  it('a multi-choice poll takes all of them', async () => {
    const { service, managerIncrement, insertedValues } = build({
      poll: { allowMultiple: true },
    });
    await service.vote('hello-world', voter, ['a', 'b', 'c']);
    expect(managerIncrement).toHaveBeenCalledTimes(3);
    expect(insertedValues).toHaveLength(3);
  });

  it('rejects an option id that belongs to another poll', async () => {
    const { service, managerIncrement } = build({
      poll: { allowMultiple: true },
    });
    await expect(
      service.vote('hello-world', voter, ['a', 'somebody-elses-option']),
    ).rejects.toBeInstanceOf(NotFoundException);
    // And nothing was written on the way to refusing.
    expect(managerIncrement).not.toHaveBeenCalled();
  });

  it('refuses a closed poll, and refuses it before touching any row', async () => {
    const { service, polls, managerIncrement } = build({
      poll: { closesAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      service.vote('hello-world', voter, ['a']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(polls.manager.transaction).not.toHaveBeenCalled();
    expect(managerIncrement).not.toHaveBeenCalled();
  });

  it('a poll whose closesAt is still ahead is open', async () => {
    const { service, managerIncrement } = build({
      poll: { closesAt: new Date(Date.now() + 60_000) },
    });
    const view = await service.vote('hello-world', voter, ['a']);
    expect(view.isClosed).toBe(false);
    expect(managerIncrement).toHaveBeenCalledTimes(1);
  });
});

describe('ForumPollsService.vote — re-voting replaces the previous selection', () => {
  it('a single-choice re-vote drops the old ballot and its count', async () => {
    const { service, managerDelete, managerDecrement, managerIncrement } =
      build({ existingVotes: [makeVote('a')] });
    await service.vote('hello-world', voter, ['b']);
    // The old pick is deleted by ROW ID, so the decrement can name exactly one
    // option.
    expect(managerDelete).toHaveBeenCalledWith(ForumPollVote, {
      id: 'vote-a',
    });
    expect(managerDecrement).toHaveBeenCalledWith(
      ForumPollOption,
      { id: 'a' },
      'voteCount',
      1,
    );
    expect(managerIncrement).toHaveBeenCalledWith(
      ForumPollOption,
      { id: 'b' },
      'voteCount',
      1,
    );
    // One out, one in — never two rows for a single-choice poll.
    expect(managerDelete).toHaveBeenCalledTimes(1);
    expect(managerIncrement).toHaveBeenCalledTimes(1);
  });

  it('a multi-choice re-vote keeps the overlap and moves only the difference', async () => {
    const { service, managerDelete, managerDecrement, managerIncrement } =
      build({
        poll: { allowMultiple: true },
        existingVotes: [makeVote('a'), makeVote('b')],
      });
    await service.vote('hello-world', voter, ['b', 'c']);
    // `b` was already held: not deleted, not re-inserted, not double-counted.
    expect(managerDelete).toHaveBeenCalledTimes(1);
    expect(managerDelete).toHaveBeenCalledWith(ForumPollVote, {
      id: 'vote-a',
    });
    expect(managerDecrement).toHaveBeenCalledWith(
      ForumPollOption,
      { id: 'a' },
      'voteCount',
      1,
    );
    expect(managerIncrement).toHaveBeenCalledTimes(1);
    expect(managerIncrement).toHaveBeenCalledWith(
      ForumPollOption,
      { id: 'c' },
      'voteCount',
      1,
    );
  });

  it('re-sending the identical selection changes nothing', async () => {
    const { service, managerDelete, managerIncrement, managerDecrement } =
      build({ existingVotes: [makeVote('a')] });
    await service.vote('hello-world', voter, ['a']);
    expect(managerDelete).not.toHaveBeenCalled();
    expect(managerIncrement).not.toHaveBeenCalled();
    expect(managerDecrement).not.toHaveBeenCalled();
  });

  it('duplicate option ids in one request count once', async () => {
    const { service, managerIncrement, insertedValues } = build();
    await service.vote('hello-world', voter, ['a', 'a']);
    expect(insertedValues).toHaveLength(1);
    expect(managerIncrement).toHaveBeenCalledTimes(1);
  });

  it('an insert that loses the unique race does not move the count', async () => {
    // `orIgnore` reports no `RETURNING` row when the ballot already existed,
    // which is the only signal that the count must NOT move.
    const { service, managerIncrement } = build({ insertedRows: [] });
    await service.vote('hello-world', voter, ['a']);
    expect(managerIncrement).not.toHaveBeenCalled();
  });

  it('a delete that affected nothing does not move the count', async () => {
    const { service, managerDelete, managerDecrement } = build({
      existingVotes: [makeVote('a')],
    });
    managerDelete.mockResolvedValue({ affected: 0 });
    await service.vote('hello-world', voter, ['b']);
    expect(managerDecrement).not.toHaveBeenCalled();
  });
});

describe('ForumPollsService.vote — what the ballot returns', () => {
  it('releases the counts to the member who just voted', async () => {
    const { service } = build({
      pollOptions: [makeOption('a', 0, 4), makeOption('b', 1, 2)],
    });
    const view = await service.vote('hello-world', voter, ['a']);
    expect(view.resultsVisible).toBe(true);
    expect(view.hasVoted).toBe(true);
    expect(view.totalVotes).toBe(6);
    expect(view.options.map((option) => option.voteCount)).toEqual([4, 2]);
    expect(view.options.map((option) => option.selected)).toEqual([
      true,
      false,
    ]);
  });
});
