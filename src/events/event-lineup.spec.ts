import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { ListingLookupService } from '../listings/listing-lookup.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventSeries } from './entities/event-series.entity';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

// UNRUN — never run tests (see repo CLAUDE.md). This file is a written,
// static-verified spec (`npx tsc --noEmit`) for Personas Phase 5 Task 4's new
// `EventsService.replaceLineup`/`getLineup`, exercised via its own complete
// `EventsService` DI graph (rather than reusing `events.service.spec.ts`'s
// `beforeEach`, whose provider list predates several of `EventsService`'s
// current constructor params).
describe('EventsService — event lineup (Personas Phase 5, Moment 5)', () => {
  let service: EventsService;
  let events: { findOne: jest.Mock };
  let cohosts: { exists: jest.Mock };
  let lineupEntries: {
    find: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let profiles: { find: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  const hostedEvent = {
    id: 'event-1',
    slug: 'drag-brunch',
    hostId: 'host-user',
    status: EventStatus.Published,
    visibility: EventVisibility.Public,
  };

  const profileFor = (userId: string, slug: string) => ({
    userId,
    slug,
    firstName: 'Ada',
    lastName: 'Lovelace',
    avatarUrl: null,
  });

  beforeEach(async () => {
    events = { findOne: jest.fn() };
    cohosts = { exists: jest.fn().mockResolvedValue(false) };
    lineupEntries = {
      find: jest.fn().mockResolvedValue([]),
      manager: {
        transaction: jest.fn((fn: (manager: unknown) => unknown) =>
          Promise.resolve(
            fn({
              delete: jest.fn(),
              create: jest.fn((_entity: unknown, plain: unknown) => plain),
              save: jest.fn(),
            }),
          ),
        ),
      },
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        // Only `rosterCounts` reads config (the attendance retention window),
        // so the service's own default stands here.
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (_key: string, defaultValue?: unknown) => defaultValue,
            ),
          },
        },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventCohost), useValue: cohosts },
        { provide: getRepositoryToken(EventRsvp), useValue: {} },
        { provide: getRepositoryToken(EventInvite), useValue: {} },
        {
          provide: getRepositoryToken(EventLineupEntry),
          useValue: lineupEntries,
        },
        // This suite only exercises the lineup, so every dependency the
        // lineup paths never touch is stubbed to its inert default.
        {
          provide: getRepositoryToken(EventSeries),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(EventAnnouncement),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        { provide: RsvpService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        {
          provide: BlockFilterService,
          useValue: { excludeBlocked: jest.fn() },
        },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: CommunityMembershipService, useValue: {} },
        { provide: EventBookmarksService, useValue: {} },
        {
          provide: EventAudienceGateService,
          useValue: { assertViewable: jest.fn() },
        },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: ListingLookupService,
          useValue: {
            findLive: jest.fn().mockResolvedValue(null),
            findLinkable: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();
    service = module.get(EventsService);
  });

  describe('replaceLineup', () => {
    it('lets the host replace the lineup', async () => {
      events.findOne.mockResolvedValue(hostedEvent);
      profiles.find.mockResolvedValue([profileFor('performer-user', 'kai')]);
      lineupEntries.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'performer-user', role: 'dj' },
      ]);

      const result = await service.replaceLineup('drag-brunch', 'host-user', [
        { memberSlug: 'kai', role: 'dj' },
      ]);

      expect(lineupEntries.manager.transaction).toHaveBeenCalledTimes(1);
      expect(result.entries).toEqual([
        {
          slug: 'kai',
          name: 'Ada Lovelace',
          avatarUrl: null,
          role: 'dj',
        },
      ]);
    });

    it('403s a non-host, non-cohost caller', async () => {
      events.findOne.mockResolvedValue(hostedEvent);
      cohosts.exists.mockResolvedValue(false);

      await expect(
        service.replaceLineup('drag-brunch', 'random-user', [
          { memberSlug: 'kai', role: 'dj' },
        ]),
      ).rejects.toThrow(ForbiddenException);
      expect(lineupEntries.manager.transaction).not.toHaveBeenCalled();
    });

    it('404s an unknown member slug', async () => {
      events.findOne.mockResolvedValue(hostedEvent);
      profiles.find.mockResolvedValue([]);

      await expect(
        service.replaceLineup('drag-brunch', 'host-user', [
          { memberSlug: 'nobody', role: 'dj' },
        ]),
      ).rejects.toThrow(NotFoundException);
      expect(lineupEntries.manager.transaction).not.toHaveBeenCalled();
    });

    it('rejects a lineup over the entry cap', async () => {
      events.findOne.mockResolvedValue(hostedEvent);
      const tooMany = Array.from({ length: 51 }, (_, index) => ({
        memberSlug: `member-${index}`,
        role: 'performing',
      }));

      await expect(
        service.replaceLineup('drag-brunch', 'host-user', tooMany),
      ).rejects.toThrow(BadRequestException);
      expect(lineupEntries.manager.transaction).not.toHaveBeenCalled();
    });
  });

  describe('getLineup', () => {
    it('returns entries plus viewerEntry for a member on the bill', async () => {
      events.findOne.mockResolvedValue(hostedEvent);
      cohosts.exists.mockResolvedValue(false);
      lineupEntries.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'performer-user', role: 'dj' },
      ]);
      profiles.find.mockResolvedValue([profileFor('performer-user', 'kai')]);

      const result = await service.getLineup('drag-brunch', 'performer-user');

      expect(result.entries).toHaveLength(1);
      expect(result.viewerEntry).toEqual({
        slug: 'kai',
        name: 'Ada Lovelace',
        avatarUrl: null,
        role: 'dj',
      });
    });

    it('returns a null viewerEntry for a viewer not on the bill', async () => {
      events.findOne.mockResolvedValue(hostedEvent);
      cohosts.exists.mockResolvedValue(false);
      lineupEntries.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'performer-user', role: 'dj' },
      ]);
      profiles.find.mockResolvedValue([profileFor('performer-user', 'kai')]);

      const result = await service.getLineup('drag-brunch', 'someone-else');

      expect(result.viewerEntry).toBeNull();
    });
  });
});
