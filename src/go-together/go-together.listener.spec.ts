import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, In } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { EVENT_DELETING } from '../events/event.events';
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
  let formation: {
    moveAfterBlock: jest.Mock;
    removeMember: jest.Mock;
    leaveGroup: jest.Mock;
    dissolveEventGroups: jest.Mock;
  };

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
      leaveGroup: jest.fn().mockResolvedValue('group'),
      dissolveEventGroups: jest.fn().mockResolvedValue(undefined),
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

    it('hands a seated member to the shared leave rule with the moment of the leave', async () => {
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
      expect(formation.leaveGroup).toHaveBeenCalledWith(seatedEntry, now);
      expect(formation.removeMember).not.toHaveBeenCalled();
      expect(entries.update).not.toHaveBeenCalled();
    });

    it('does nothing when the member is no longer seated in that group', async () => {
      entries.findOne.mockResolvedValue(null);

      await listener.onMatchedGroupMemberLeft(chatLeave, now);

      expect(formation.leaveGroup).not.toHaveBeenCalled();
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
      formation.leaveGroup.mockRejectedValue(new Error('database is down'));
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

  // ENG-433: a hard delete cascades the groups away, so the matched chats end
  // first and a chat that cannot be ended keeps the gathering.
  describe('a gathering about to be hard-deleted', () => {
    it('dissolves every matched chat of the gathering and insists each one ends', async () => {
      await listener.onEventDeleting({ eventId: 'event-1' });

      expect(formation.dissolveEventGroups).toHaveBeenCalledWith('event-1', {
        shouldFailWhenChatStaysOpen: true,
      });
    });

    it('lets a dissolve failure propagate so the delete can abort', async () => {
      formation.dissolveEventGroups.mockRejectedValue(
        new Error('chat service is down'),
      );

      await expect(
        listener.onEventDeleting({ eventId: 'event-1' }),
      ).rejects.toThrow('chat service is down');
    });

    // Through the real emitter: `emitAsync` waits for the dissolve, and the
    // listener's `suppressErrors: false` hands a failure back to the emitter,
    // which is what `EventsService.remove` relies on to keep the gathering.
    describe('through the event emitter', () => {
      async function bootEmitter(): Promise<EventEmitter2> {
        const moduleRef = await Test.createTestingModule({
          imports: [EventEmitterModule.forRoot()],
          providers: [
            GoTogetherListener,
            { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
            { provide: getRepositoryToken(Event), useValue: events },
            { provide: GoTogetherFormationService, useValue: formation },
          ],
        }).compile();
        await moduleRef.init();
        return moduleRef.get(EventEmitter2);
      }

      it('resolves only after the chats are dissolved', async () => {
        let hasDissolved = false;
        formation.dissolveEventGroups.mockImplementation(async () => {
          await Promise.resolve();
          hasDissolved = true;
        });
        const emitter = await bootEmitter();

        await emitter.emitAsync(EVENT_DELETING, { eventId: 'event-1' });

        expect(hasDissolved).toBe(true);
      });

      it('rejects when a chat could not be ended', async () => {
        formation.dissolveEventGroups.mockRejectedValue(
          new Error('chat service is down'),
        );
        const emitter = await bootEmitter();

        await expect(
          emitter.emitAsync(EVENT_DELETING, { eventId: 'event-1' }),
        ).rejects.toThrow('chat service is down');
      });
    });
  });
});
