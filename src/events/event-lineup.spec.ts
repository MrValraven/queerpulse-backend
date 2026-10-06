import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  EventLineupEntry,
  EventLineupEntryStatus,
} from './entities/event-lineup-entry.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EventLineupService, MAX_LINEUP_ENTRIES } from './event-lineup.service';
import { EVENT_LINEUP_ANSWERED, EVENT_LINEUP_INVITED } from './event.events';
import { EventsService } from './events.service';

// UNRUN: written and statically verified only; tests run on request.
describe('EventLineupService (lineup invites)', () => {
  let service: EventLineupService;
  let lineupEntries: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let insertExecute: jest.Mock;
  let insertValues: jest.Mock;
  let events: { findOne: jest.Mock; count: jest.Mock };
  let rsvps: { exists: jest.Mock };
  let profiles: { find: jest.Mock; findOne: jest.Mock };
  let usersService: { findById: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock; assertCanView: jest.Mock };
  let connectionsService: {
    areConnected: jest.Mock;
    mutualCountsByUserIds: jest.Mock;
  };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  const hostedEvent = {
    id: 'event-1',
    slug: 'drag-brunch',
    hostId: 'host-user',
    status: EventStatus.Published,
    title: 'Drag brunch',
    startAt: new Date('2026-11-01T12:00:00Z'),
    endAt: null,
    timezone: 'Europe/Lisbon',
    venue: 'Cais',
    isOnline: false,
  };

  const profileFor = (userId: string, slug: string) => ({
    userId,
    slug,
    firstName: 'Ada',
    lastName: 'Lovelace',
    avatarUrl: null,
  });

  const entryFor = (overrides: Partial<EventLineupEntry>) => ({
    id: 'entry-1',
    eventId: 'event-1',
    userId: 'dj-user',
    role: 'dj',
    status: EventLineupEntryStatus.Pending,
    invitedById: 'host-user',
    respondedAt: null,
    createdAt: new Date('2026-10-06T10:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    insertExecute = jest.fn().mockResolvedValue({ raw: [{ id: 'entry-1' }] });
    insertValues = jest.fn().mockReturnThis();
    const insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: insertValues,
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: insertExecute,
    };
    lineupEntries = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => insertBuilder),
    };
    events = {
      findOne: jest.fn().mockResolvedValue(hostedEvent),
      count: jest.fn().mockResolvedValue(3),
    };
    rsvps = { exists: jest.fn().mockResolvedValue(false) };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(profileFor('dj-user', 'dj-ana')),
    };
    usersService = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'dj-user', status: UserStatus.Active }),
    };
    eventsService = {
      isOrganizer: jest.fn((_eventId: string, userId: string) =>
        Promise.resolve(userId === 'host-user'),
      ),
      assertCanView: jest.fn((_event: unknown, viewerId: string) =>
        Promise.resolve(viewerId === 'host-user'),
      ),
    };
    connectionsService = {
      areConnected: jest.fn().mockResolvedValue(true),
      mutualCountsByUserIds: jest.fn().mockResolvedValue(new Map()),
    };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventLineupService,
        {
          provide: getRepositoryToken(EventLineupEntry),
          useValue: lineupEntries,
        },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: UsersService, useValue: usersService },
        { provide: EventsService, useValue: eventsService },
        { provide: ConnectionsService, useValue: connectionsService },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();
    service = module.get(EventLineupService);
  });

  describe('invite', () => {
    const dto = { memberSlug: 'dj-ana', role: 'dj' };

    it('creates a pending row and emits the invite event', async () => {
      await service.invite('drag-brunch', 'host-user', dto);
      expect(insertExecute).toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          status: EventLineupEntryStatus.Pending,
          invitedById: 'host-user',
          respondedAt: null,
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_LINEUP_INVITED,
        expect.objectContaining({
          entryId: 'entry-1',
          inviterId: 'host-user',
          inviteeId: 'dj-user',
          role: 'dj',
        }),
      );
    });

    it('404s for a member whose account is not active', async () => {
      usersService.findById.mockResolvedValue({
        id: 'dj-user',
        status: UserStatus.Suspended,
      });
      await expect(
        service.invite('drag-brunch', 'host-user', dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(insertExecute).not.toHaveBeenCalled();
    });

    it('403s when the organizer and the member are blocked either way', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(
        service.invite('drag-brunch', 'host-user', dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        'host-user',
        'dj-user',
      );
      expect(insertExecute).not.toHaveBeenCalled();
    });

    it('rejects a non-organizer with 403', async () => {
      await expect(
        service.invite('drag-brunch', 'stranger-user', dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects inviting yourself with 400', async () => {
      profiles.findOne.mockResolvedValue(profileFor('host-user', 'host'));
      await expect(
        service.invite('drag-brunch', 'host-user', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a member who is neither a connection nor going with 403', async () => {
      connectionsService.areConnected.mockResolvedValue(false);
      rsvps.exists.mockResolvedValue(false);
      await expect(
        service.invite('drag-brunch', 'host-user', dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(insertExecute).not.toHaveBeenCalled();
    });

    it('accepts a going member who is not a connection', async () => {
      connectionsService.areConnected.mockResolvedValue(false);
      rsvps.exists.mockResolvedValue(true);
      await service.invite('drag-brunch', 'host-user', dto);
      expect(insertExecute).toHaveBeenCalled();
    });

    it('409s when the member is already pending or accepted', async () => {
      lineupEntries.findOne.mockResolvedValue(
        entryFor({ status: EventLineupEntryStatus.Accepted }),
      );
      await expect(
        service.invite('drag-brunch', 'host-user', dto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s when a concurrent insert wins the unique constraint', async () => {
      insertExecute.mockResolvedValue({ raw: [] });
      await expect(
        service.invite('drag-brunch', 'host-user', dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('re-invites a member who declined by resetting their row', async () => {
      lineupEntries.findOne.mockResolvedValue(
        entryFor({
          status: EventLineupEntryStatus.Declined,
          invitedById: 'cohost-user',
          respondedAt: new Date(),
        }),
      );
      await service.invite('drag-brunch', 'host-user', {
        memberSlug: 'dj-ana',
        role: 'performer',
      });
      expect(lineupEntries.update).toHaveBeenCalledWith(
        { id: 'entry-1', status: EventLineupEntryStatus.Declined },
        {
          status: EventLineupEntryStatus.Pending,
          role: 'performer',
          invitedById: 'host-user',
          respondedAt: null,
        },
      );
      expect(insertExecute).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_LINEUP_INVITED,
        expect.objectContaining({ entryId: 'entry-1', role: 'performer' }),
      );
    });

    it('400s once pending plus accepted rows reach the cap', async () => {
      lineupEntries.count.mockResolvedValue(MAX_LINEUP_ENTRIES);
      await expect(
        service.invite('drag-brunch', 'host-user', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(lineupEntries.count).toHaveBeenCalled();
      expect(insertExecute).not.toHaveBeenCalled();
    });
  });

  describe('getLineup', () => {
    const rows = [
      entryFor({
        id: 'entry-accepted',
        userId: 'accepted-user',
        status: EventLineupEntryStatus.Accepted,
      }),
      entryFor({
        id: 'entry-pending',
        userId: 'pending-user',
        status: EventLineupEntryStatus.Pending,
      }),
    ];

    beforeEach(() => {
      lineupEntries.find.mockResolvedValue(rows);
      profiles.find.mockResolvedValue([
        profileFor('accepted-user', 'accepted'),
        profileFor('pending-user', 'pending'),
      ]);
    });

    it('shows organizers every row with its status', async () => {
      const lineup = await service.getLineup('drag-brunch', 'host-user');
      expect(lineup.entries.map((entry) => entry.status)).toEqual([
        EventLineupEntryStatus.Accepted,
        EventLineupEntryStatus.Pending,
      ]);
    });

    it('shows everyone else accepted rows only', async () => {
      const lineup = await service.getLineup('drag-brunch', 'guest-user');
      expect(lineup.entries.map((entry) => entry.slug)).toEqual(['accepted']);
    });

    it("returns the viewer's own pending row as viewerEntry", async () => {
      const lineup = await service.getLineup('drag-brunch', 'pending-user');
      expect(lineup.viewerEntry).toEqual(
        expect.objectContaining({
          id: 'entry-pending',
          status: EventLineupEntryStatus.Pending,
        }),
      );
      expect(lineup.entries.map((entry) => entry.slug)).toEqual(['accepted']);
    });
  });

  describe('respond', () => {
    it('accepts a pending invite and notifies the inviter', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({}));
      const result = await service.respond('entry-1', 'dj-user', 'accepted');
      expect(result.status).toBe(EventLineupEntryStatus.Accepted);
      expect(lineupEntries.update).toHaveBeenCalledWith(
        { id: 'entry-1', status: EventLineupEntryStatus.Pending },
        expect.objectContaining({ status: EventLineupEntryStatus.Accepted }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_LINEUP_ANSWERED,
        expect.objectContaining({
          recipientId: 'host-user',
          performerId: 'dj-user',
          outcome: 'accepted',
        }),
      );
    });

    it('falls back to the host when the inviter is gone', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({ invitedById: null }));
      await service.respond('entry-1', 'dj-user', 'declined');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_LINEUP_ANSWERED,
        expect.objectContaining({
          recipientId: 'host-user',
          outcome: 'declined',
        }),
      );
    });

    it('falls back to the host when the inviting co-host no longer organizes', async () => {
      lineupEntries.findOne.mockResolvedValue(
        entryFor({ invitedById: 'former-cohost-user' }),
      );
      await service.respond('entry-1', 'dj-user', 'accepted');
      expect(eventsService.isOrganizer).toHaveBeenCalledWith(
        'event-1',
        'former-cohost-user',
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_LINEUP_ANSWERED,
        expect.objectContaining({
          recipientId: 'host-user',
          performerId: 'dj-user',
        }),
      );
    });

    it('404s and records nothing when the gathering was taken down', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({}));
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });
      await expect(
        service.respond('entry-1', 'dj-user', 'accepted'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'event',
        'event-1',
      );
      expect(lineupEntries.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('emits nothing when the recipient is the performer', async () => {
      // A co-host invited the host and that co-host's account is gone, so the
      // host fallback would notify the host about their own answer.
      lineupEntries.findOne.mockResolvedValue(
        entryFor({ userId: 'host-user', invitedById: null }),
      );
      const result = await service.respond('entry-1', 'host-user', 'accepted');
      expect(result.status).toBe(EventLineupEntryStatus.Accepted);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('404s for anyone but the invited member', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({}));
      await expect(
        service.respond('entry-1', 'host-user', 'accepted'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s when the invite is no longer pending', async () => {
      lineupEntries.findOne.mockResolvedValue(
        entryFor({ status: EventLineupEntryStatus.Declined }),
      );
      await expect(
        service.respond('entry-1', 'dj-user', 'accepted'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s and emits nothing when a concurrent answer won', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({}));
      lineupEntries.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.respond('entry-1', 'dj-user', 'accepted'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getInvite', () => {
    it('returns the invite without the audience gate', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({}));
      profiles.findOne.mockResolvedValue(profileFor('host-user', 'host'));
      const invite = await service.getInvite('entry-1', 'dj-user');
      expect(invite.event.slug).toBe('drag-brunch');
      expect(invite.event.goingCount).toBeNull();
      expect(invite.inviter?.slug).toBe('host');
      expect(eventsService.assertCanView).not.toHaveBeenCalled();
    });

    it('returns no inviter when the inviter and the host are both gone', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({ invitedById: null }));
      events.findOne.mockResolvedValue({ ...hostedEvent, hostId: null });
      const invite = await service.getInvite('entry-1', 'dj-user');
      expect(invite.inviter).toBeNull();
      expect(profiles.findOne).not.toHaveBeenCalled();
    });

    it('404s for anyone but the invited member', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({}));
      await expect(
        service.getInvite('entry-1', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when a moderator has hidden the gathering', async () => {
      lineupEntries.findOne.mockResolvedValue(entryFor({}));
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });
      await expect(service.getInvite('entry-1', 'dj-user')).rejects.toThrow(
        new NotFoundException('Invite not found'),
      );
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'event',
        'event-1',
      );
    });
  });

  describe('changeRole, remove, leave', () => {
    it('changes a role for an organizer', async () => {
      await service.changeRole('drag-brunch', 'host-user', 'dj-ana', 'chef');
      expect(lineupEntries.update).toHaveBeenCalledWith(
        { eventId: 'event-1', userId: 'dj-user' },
        { role: 'chef' },
      );
    });

    it('404s removing someone who is not on the lineup', async () => {
      lineupEntries.delete.mockResolvedValue({ affected: 0 });
      await expect(
        service.remove('drag-brunch', 'host-user', 'dj-ana'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets an accepted performer leave', async () => {
      await service.leave('drag-brunch', 'dj-user');
      expect(lineupEntries.delete).toHaveBeenCalledWith({
        eventId: 'event-1',
        userId: 'dj-user',
        status: EventLineupEntryStatus.Accepted,
      });
    });

    it('404s leaving when the caller has no accepted row', async () => {
      lineupEntries.delete.mockResolvedValue({ affected: 0 });
      await expect(
        service.leave('drag-brunch', 'dj-user'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
