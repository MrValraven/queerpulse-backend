import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, In } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { GoTogetherFormationService } from './go-together-formation.service';
import { GoTogetherListener } from './go-together.listener';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function makeEntry(fields: Partial<EventMatchEntry>): EventMatchEntry {
  return {
    eventId: 'event-1',
    pairPartnerId: null,
    pairStatus: 'none',
    status: 'waiting',
    groupId: null,
    ...fields,
  } as EventMatchEntry;
}

describe('GoTogetherListener', () => {
  const blockEvent = { blockerId: 'user-1', blockedId: 'user-2' };

  let listener: GoTogetherListener;
  let entries: { find: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let events: { find: jest.Mock; findOne: jest.Mock };
  let formation: { moveAfterBlock: jest.Mock; removeMember: jest.Mock };

  beforeEach(async () => {
    entries = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    events = {
      find: jest.fn().mockResolvedValue([{ id: 'event-1' }]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    formation = {
      moveAfterBlock: jest.fn().mockResolvedValue(undefined),
      removeMember: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherListener,
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: GoTogetherFormationService, useValue: formation },
      ],
    }).compile();
    listener = moduleRef.get(GoTogetherListener);
  });

  it('moves the blocker out when both are grouped together in an upcoming gathering', async () => {
    entries.find.mockResolvedValue([
      makeEntry({
        id: 'entry-1',
        userId: 'user-1',
        status: 'grouped',
        groupId: 'group-1',
      }),
      makeEntry({
        id: 'entry-2',
        userId: 'user-2',
        status: 'grouped',
        groupId: 'group-1',
      }),
    ]);
    const before = Date.now();

    await listener.onMemberBlocked(blockEvent);

    expect(entries.find).toHaveBeenCalledWith({
      where: {
        userId: In(['user-1', 'user-2']),
        status: In(['waiting', 'grouped', 'unmatched']),
      },
    });
    const [[eventQuery]] = events.find.mock.calls as [
      [{ where: { id: FindOperator<string[]>; startAt: FindOperator<Date> } }],
    ];
    expect(eventQuery.where.id).toEqual(In(['event-1']));
    expect(eventQuery.where.startAt.type).toBe('moreThan');
    const since = eventQuery.where.startAt.value.getTime();
    expect(since).toBeGreaterThanOrEqual(before - TWELVE_HOURS_MS);
    expect(since).toBeLessThanOrEqual(Date.now() - TWELVE_HOURS_MS);
    expect(formation.moveAfterBlock).toHaveBeenCalledTimes(1);
    expect(formation.moveAfterBlock).toHaveBeenCalledWith(
      'event-1',
      'user-1',
      'user-2',
    );
    expect(entries.update).not.toHaveBeenCalled();
  });

  it('moves nobody when the two are in different groups', async () => {
    entries.find.mockResolvedValue([
      makeEntry({
        id: 'entry-1',
        userId: 'user-1',
        status: 'grouped',
        groupId: 'group-1',
      }),
      makeEntry({
        id: 'entry-2',
        userId: 'user-2',
        status: 'grouped',
        groupId: 'group-2',
      }),
    ]);

    await listener.onMemberBlocked(blockEvent);

    expect(formation.moveAfterBlock).not.toHaveBeenCalled();
    expect(entries.update).not.toHaveBeenCalled();
  });

  it('breaks an accepted pair between the two even when neither is grouped', async () => {
    entries.find.mockResolvedValue([
      makeEntry({
        id: 'entry-1',
        userId: 'user-1',
        pairPartnerId: 'user-2',
        pairStatus: 'accepted',
      }),
      makeEntry({
        id: 'entry-2',
        userId: 'user-2',
        pairPartnerId: 'user-1',
        pairStatus: 'accepted',
      }),
    ]);

    await listener.onMemberBlocked(blockEvent);

    expect(entries.update).toHaveBeenCalledWith(
      { id: In(['entry-1', 'entry-2']) },
      { pairStatus: 'none', pairPartnerId: null },
    );
    expect(formation.moveAfterBlock).not.toHaveBeenCalled();
  });

  it('clears a pending invite from the blocked member to the blocker', async () => {
    entries.find.mockResolvedValue([
      makeEntry({
        id: 'entry-2',
        userId: 'user-2',
        pairPartnerId: 'user-1',
        pairStatus: 'pending',
      }),
    ]);

    await listener.onMemberBlocked(blockEvent);

    expect(entries.update).toHaveBeenCalledWith(
      { id: In(['entry-2']) },
      { pairStatus: 'none', pairPartnerId: null },
    );
  });

  it('changes nothing for a gathering that is no longer upcoming', async () => {
    entries.find.mockResolvedValue([
      makeEntry({
        id: 'entry-1',
        userId: 'user-1',
        status: 'grouped',
        groupId: 'group-1',
        pairPartnerId: 'user-2',
        pairStatus: 'accepted',
      }),
      makeEntry({
        id: 'entry-2',
        userId: 'user-2',
        status: 'grouped',
        groupId: 'group-1',
        pairPartnerId: 'user-1',
        pairStatus: 'accepted',
      }),
    ]);
    events.find.mockResolvedValue([]);

    await listener.onMemberBlocked(blockEvent);

    expect(entries.update).not.toHaveBeenCalled();
    expect(formation.moveAfterBlock).not.toHaveBeenCalled();
  });

  it('logs and swallows a failure so the block itself is never affected', async () => {
    entries.find.mockResolvedValue([
      makeEntry({
        id: 'entry-1',
        userId: 'user-1',
        status: 'grouped',
        groupId: 'group-1',
      }),
      makeEntry({
        id: 'entry-2',
        userId: 'user-2',
        status: 'grouped',
        groupId: 'group-1',
      }),
    ]);
    formation.moveAfterBlock.mockRejectedValue(new Error('chat is down'));
    const loggerError = jest
      .spyOn(
        (listener as unknown as { logger: { error: (text: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await expect(listener.onMemberBlocked(blockEvent)).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('chat is down'),
    );
  });

  describe('leaving the matched chat', () => {
    const chatLeave = {
      conversationId: 'conversation-1',
      eventMatchGroupId: 'group-1',
      userId: 'user-1',
    };
    const now = new Date('2026-10-10T12:00:00Z');

    beforeEach(() => {
      // Starts eight hours after `now`.
      events.findOne.mockResolvedValue({
        id: 'event-1',
        startAt: new Date('2026-10-10T20:00:00Z'),
      });
    });

    it('removes the member from Go together before the gathering starts', async () => {
      const seatedEntry = makeEntry({
        id: 'entry-1',
        userId: 'user-1',
        status: 'grouped',
        groupId: 'group-1',
      });
      entries.findOne.mockResolvedValue(seatedEntry);

      await listener.onMatchedGroupMemberLeft(chatLeave, now);

      expect(entries.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', groupId: 'group-1', status: 'grouped' },
      });
      expect(events.findOne).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        select: { id: true, startAt: true },
      });
      expect(formation.removeMember).toHaveBeenCalledWith(seatedEntry);
    });

    it('keeps the member in the group once the gathering has started, so only the chat ends', async () => {
      entries.findOne.mockResolvedValue(
        makeEntry({
          id: 'entry-1',
          userId: 'user-1',
          status: 'grouped',
          groupId: 'group-1',
        }),
      );
      const afterStart = new Date('2026-10-10T21:00:00Z');

      await listener.onMatchedGroupMemberLeft(chatLeave, afterStart);

      expect(formation.removeMember).not.toHaveBeenCalled();
      expect(entries.update).not.toHaveBeenCalled();
    });

    it('does nothing when the member is no longer seated in that group', async () => {
      entries.findOne.mockResolvedValue(null);

      await listener.onMatchedGroupMemberLeft(chatLeave, now);

      expect(formation.removeMember).not.toHaveBeenCalled();
    });

    it('logs and swallows a failure so the chat leave itself is never affected', async () => {
      entries.findOne.mockResolvedValue(
        makeEntry({
          id: 'entry-1',
          userId: 'user-1',
          status: 'grouped',
          groupId: 'group-1',
        }),
      );
      formation.removeMember.mockRejectedValue(new Error('database is down'));
      const loggerError = jest
        .spyOn(
          (
            listener as unknown as {
              logger: { error: (text: string) => void };
            }
          ).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      await expect(
        listener.onMatchedGroupMemberLeft(chatLeave, now),
      ).resolves.toBeUndefined();

      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('database is down'),
      );
    });
  });
});
