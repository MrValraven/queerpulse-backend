import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import {
  EventLineupEntry,
  EventLineupEntryStatus,
} from '../events/entities/event-lineup-entry.entity';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { BlockFilterService } from '../social/block-filter.service';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import { SubprofileSection } from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  eligibilityKey,
  hasQualifyingOwner,
  MAX_AFFILIATION_OPTIONS_PER_TYPE,
  SubprofileAffiliationEligibilityService,
} from './subprofile-affiliation-eligibility.service';

// A chainable query-builder stub whose `getMany` resolves `rows`.
function makeQueryBuilderStub(rows: unknown[]) {
  const queryBuilder = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    take: jest.fn(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  for (const chainableMethod of [
    queryBuilder.where,
    queryBuilder.andWhere,
    queryBuilder.orderBy,
    queryBuilder.addOrderBy,
    queryBuilder.take,
  ]) {
    chainableMethod.mockReturnValue(queryBuilder);
  }
  return queryBuilder;
}

describe('SubprofileAffiliationEligibilityService', () => {
  let service: SubprofileAffiliationEligibilityService;
  let subprofiles: { find: jest.Mock };
  let members: { find: jest.Mock };
  let communityMembers: { find: jest.Mock };
  let eventCohosts: { find: jest.Mock };
  let eventLineupEntries: { find: jest.Mock };
  let eventRsvps: { find: jest.Mock };
  let events: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let communities: { createQueryBuilder: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock; blockedUserIds: jest.Mock };

  beforeEach(async () => {
    subprofiles = { find: jest.fn().mockResolvedValue([]) };
    members = { find: jest.fn().mockResolvedValue([]) };
    communityMembers = { find: jest.fn().mockResolvedValue([]) };
    eventCohosts = { find: jest.fn().mockResolvedValue([]) };
    eventLineupEntries = { find: jest.fn().mockResolvedValue([]) };
    eventRsvps = { find: jest.fn().mockResolvedValue([]) };
    events = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    communities = { createQueryBuilder: jest.fn() };
    blockFilter = {
      excludeBlocked: jest.fn(),
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubprofileAffiliationEligibilityService,
        { provide: getRepositoryToken(Subprofile), useValue: subprofiles },
        { provide: getRepositoryToken(SubprofileMember), useValue: members },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(EventCohost), useValue: eventCohosts },
        {
          provide: getRepositoryToken(EventLineupEntry),
          useValue: eventLineupEntries,
        },
        { provide: getRepositoryToken(EventRsvp), useValue: eventRsvps },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();

    service = module.get(SubprofileAffiliationEligibilityService);
  });

  describe('ownerIdsFor', () => {
    it('unions the creator with every co-owner, once each, per persona', async () => {
      subprofiles.find.mockResolvedValue([
        { id: 'sp-1', userId: 'creator-1' },
        { id: 'sp-2', userId: 'creator-2' },
      ]);
      members.find.mockResolvedValue([
        { subprofileId: 'sp-1', userId: 'creator-1' },
        { subprofileId: 'sp-1', userId: 'co-owner-1' },
      ]);

      const ownerIdsBySubprofileId = await service.ownerIdsFor([
        'sp-1',
        'sp-2',
        'sp-1',
      ]);

      expect(ownerIdsBySubprofileId.get('sp-1')).toEqual([
        'creator-1',
        'co-owner-1',
      ]);
      expect(ownerIdsBySubprofileId.get('sp-2')).toEqual(['creator-2']);
      // One query per table, over the distinct ids.
      expect(members.find).toHaveBeenCalledTimes(1);
      expect(subprofiles.find).toHaveBeenCalledWith({
        where: { id: In(['sp-1', 'sp-2']) },
        select: { id: true, userId: true },
      });
    });

    it('runs no query for an empty list', async () => {
      await expect(service.ownerIdsFor([])).resolves.toEqual(new Map());
      expect(members.find).not.toHaveBeenCalled();
      expect(subprofiles.find).not.toHaveBeenCalled();
    });
  });

  describe('eligibleTargetKeys', () => {
    it('counts hosting, co-hosting, the lineup, going RSVPs and community membership', async () => {
      communityMembers.find.mockResolvedValue([
        { communityId: 'community-1', userId: 'owner-2' },
      ]);
      eventCohosts.find.mockResolvedValue([
        { eventId: 'event-2', userId: 'owner-1' },
      ]);
      eventLineupEntries.find.mockResolvedValue([
        { eventId: 'event-3', userId: 'owner-2' },
      ]);
      eventRsvps.find.mockResolvedValue([
        { eventId: 'event-4', userId: 'owner-1' },
      ]);

      const eligibleKeys = await service.eligibleTargetKeys(
        ['owner-1', 'owner-2'],
        [
          { id: 'event-1', hostId: 'owner-1' },
          { id: 'event-2', hostId: 'someone-else' },
          { id: 'event-3', hostId: null },
          { id: 'event-4', hostId: null },
          { id: 'event-5', hostId: null },
        ],
        ['community-1', 'community-2'],
      );

      expect(eligibleKeys).toEqual(
        new Set([
          eligibilityKey('event', 'event-1', 'owner-1'),
          eligibilityKey('event', 'event-2', 'owner-1'),
          eligibilityKey('event', 'event-3', 'owner-2'),
          eligibilityKey('event', 'event-4', 'owner-1'),
          eligibilityKey('community', 'community-1', 'owner-2'),
        ]),
      );
      // Only a `going` RSVP qualifies: maybe, waitlisted and cancelled rows
      // are never even read.
      expect(eventRsvps.find).toHaveBeenCalledWith({
        where: {
          eventId: In(['event-1', 'event-2', 'event-3', 'event-4', 'event-5']),
          userId: In(['owner-1', 'owner-2']),
          status: RsvpStatus.Going,
        },
        select: { eventId: true, userId: true },
      });
      expect(
        hasQualifyingOwner(eligibleKeys, 'event', 'event-5', [
          'owner-1',
          'owner-2',
        ]),
      ).toBe(false);
      expect(
        hasQualifyingOwner(eligibleKeys, 'community', 'community-1', [
          'owner-1',
          'owner-2',
        ]),
      ).toBe(true);
    });

    it('counts only accepted lineup rows toward event eligibility', async () => {
      await service.eligibleTargetKeys(
        ['owner-1'],
        [{ id: 'event-1', hostId: null }],
        [],
      );

      expect(eventLineupEntries.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: EventLineupEntryStatus.Accepted,
          }),
        }),
      );
    });

    it('skips going RSVPs when asked', async () => {
      eventRsvps.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'owner-1' },
      ]);

      const eligibleKeys = await service.eligibleTargetKeys(
        ['owner-1'],
        [{ id: 'event-1', hostId: null }],
        [],
        { shouldCountGoingRsvps: false },
      );

      expect(eligibleKeys).toEqual(new Set());
      expect(eventRsvps.find).not.toHaveBeenCalled();
      // Co-hosts and the lineup are still read.
      expect(eventCohosts.find).toHaveBeenCalledTimes(1);
      expect(eventLineupEntries.find).toHaveBeenCalledTimes(1);
    });

    it('runs no query when there are no owners', async () => {
      await expect(
        service.eligibleTargetKeys([], [{ id: 'event-1', hostId: null }], []),
      ).resolves.toEqual(new Set());
      expect(eventRsvps.find).not.toHaveBeenCalled();
      expect(communityMembers.find).not.toHaveBeenCalled();
    });
  });

  describe('listOptions', () => {
    const bookClubRow = {
      id: 'community-1',
      slug: 'book-club',
      name: 'Queer Book Club',
      ownerId: 'someone',
    };
    const picnicRow = {
      id: 'event-1',
      slug: 'pride-picnic',
      title: 'Pride Picnic',
      coverImageUrl: null,
      startAt: new Date('2026-06-28T12:00:00.000Z'),
      hostId: 'someone',
    };

    it('counts only accepted lineup rows when listing event options', async () => {
      communities.createQueryBuilder.mockReturnValue(makeQueryBuilderStub([]));
      events.createQueryBuilder.mockReturnValue(makeQueryBuilderStub([]));
      events.find.mockResolvedValue([]);
      eventCohosts.find.mockResolvedValue([]);
      eventLineupEntries.find.mockResolvedValue([]);
      eventRsvps.find.mockResolvedValue([]);

      await service.listOptions('owner-1', 'owner-1');

      expect(eventLineupEntries.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: EventLineupEntryStatus.Accepted,
          }),
        }),
      );
    });

    it('returns the requester communities then events, hand-mapped, capped and ordered upcoming first', async () => {
      const communityQuery = makeQueryBuilderStub([bookClubRow]);
      const eventQuery = makeQueryBuilderStub([picnicRow]);
      communities.createQueryBuilder.mockReturnValue(communityQuery);
      events.createQueryBuilder.mockReturnValue(eventQuery);
      events.find.mockResolvedValue([{ id: 'event-1' }]);
      eventCohosts.find.mockResolvedValue([{ eventId: 'event-2' }]);
      eventLineupEntries.find.mockResolvedValue([{ eventId: 'event-1' }]);
      eventRsvps.find.mockResolvedValue([{ eventId: 'event-3' }]);

      const options = await service.listOptions('owner-1', 'owner-1');

      expect(options).toEqual([
        {
          targetType: 'community',
          targetSlug: 'book-club',
          name: 'Queer Book Club',
          imageUrl: null,
          startsAt: null,
        },
        {
          targetType: 'event',
          targetSlug: 'pride-picnic',
          name: 'Pride Picnic',
          imageUrl: null,
          startsAt: '2026-06-28T12:00:00.000Z',
        },
      ]);
      // Every event candidate lookup is keyed by the requester alone.
      expect(events.find).toHaveBeenCalledWith({
        where: { hostId: 'owner-1' },
        select: { id: true },
      });
      expect(eventCohosts.find).toHaveBeenCalledWith({
        where: { userId: 'owner-1' },
        select: { eventId: true },
      });
      expect(eventLineupEntries.find).toHaveBeenCalledWith({
        where: { userId: 'owner-1', status: EventLineupEntryStatus.Accepted },
        select: { eventId: true },
      });
      expect(eventRsvps.find).toHaveBeenCalledWith({
        where: { userId: 'owner-1', status: RsvpStatus.Going },
        select: { eventId: true },
      });
      // The candidates are deduplicated before the one events query.
      expect(eventQuery.where).toHaveBeenCalledWith(
        'event.id IN (:...candidateEventIds)',
        { candidateEventIds: ['event-1', 'event-2', 'event-3'] },
      );
      expect(communityQuery.andWhere).toHaveBeenCalledWith(
        'community.archivedAt IS NULL',
      );
      expect(communityQuery.andWhere).toHaveBeenCalledWith(
        expect.stringContaining(
          '"requesterMembership"."user_id" = :requesterId',
        ),
        { requesterId: 'owner-1' },
      );
      expect(communityQuery.orderBy).toHaveBeenCalledWith(
        'community.name',
        'ASC',
      );
      expect(eventQuery.orderBy).toHaveBeenCalledWith(
        '("event"."start_at" < now())',
        'ASC',
      );
      expect(eventQuery.addOrderBy).toHaveBeenCalledWith(
        '"event"."start_at"',
        'DESC',
      );
      expect(communityQuery.take).toHaveBeenCalledWith(
        MAX_AFFILIATION_OPTIONS_PER_TYPE,
      );
      expect(eventQuery.take).toHaveBeenCalledWith(
        MAX_AFFILIATION_OPTIONS_PER_TYPE,
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        communityQuery,
        'owner-1',
        '"community"."owner_id"',
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        eventQuery,
        'owner-1',
        '"event"."host_id"',
      );
      // The requester is the persona userId, whose block check is already in
      // place, so no second predicate is added.
      const andWhereCalls = (
        communityQuery.andWhere.mock.calls as unknown[][]
      ).concat(eventQuery.andWhere.mock.calls as unknown[][]);
      const hasRequesterBlockPredicate = andWhereCalls.some((call) =>
        String(call[0]).includes('"requesterBlock"'),
      );
      expect(hasRequesterBlockPredicate).toBe(false);
    });

    it('also block-filters against a co-owner who asks, on both queries', async () => {
      const communityQuery = makeQueryBuilderStub([bookClubRow]);
      const eventQuery = makeQueryBuilderStub([picnicRow]);
      communities.createQueryBuilder.mockReturnValue(communityQuery);
      events.createQueryBuilder.mockReturnValue(eventQuery);
      eventRsvps.find.mockResolvedValue([{ eventId: 'event-1' }]);

      await service.listOptions('co-owner-1', 'owner-1');

      // The persona userId keeps the save-time block check.
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        communityQuery,
        'owner-1',
        '"community"."owner_id"',
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        eventQuery,
        'owner-1',
        '"event"."host_id"',
      );
      // The requester gets its own either-way predicate under its own
      // parameter name.
      expect(communityQuery.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"community"."owner_id"'),
        { requesterBlockUserId: 'co-owner-1' },
      );
      expect(eventQuery.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"event"."host_id"'),
        { requesterBlockUserId: 'co-owner-1' },
      );
      // Memberships and RSVPs are read for the requester only.
      expect(communityQuery.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"requesterMembership"'),
        { requesterId: 'co-owner-1' },
      );
      expect(eventRsvps.find).toHaveBeenCalledWith({
        where: { userId: 'co-owner-1', status: RsvpStatus.Going },
        select: { eventId: true },
      });
    });

    it('runs no events query when the requester has no event candidates', async () => {
      const communityQuery = makeQueryBuilderStub([]);
      communities.createQueryBuilder.mockReturnValue(communityQuery);

      await expect(service.listOptions('owner-1', 'owner-1')).resolves.toEqual(
        [],
      );
      expect(events.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // A published public event row carrying every column the flash day ref
  // reads, plus the private door details the ref must leave behind.
  function makeFlashDayEventRow(overrides: Partial<Event> = {}) {
    return {
      id: 'event-1',
      slug: 'flash-day-arroios',
      title: 'Flash Day at Arroios',
      startAt: new Date('2026-11-14T11:00:00.000Z'),
      endAt: new Date('2026-11-14T19:00:00.000Z'),
      venue: 'Casa do Bairro',
      neighbourhood: 'Arroios',
      isOnline: false,
      coverImageUrl: null,
      address: 'Rua Secreta 1',
      arrivalNotes: 'ring twice',
      hostId: 'co-owner-2',
      status: EventStatus.Published,
      visibility: EventVisibility.Public,
      ...overrides,
    };
  }

  const flashDayArroiosRef = {
    slug: 'flash-day-arroios',
    title: 'Flash Day at Arroios',
    startsAt: '2026-11-14T11:00:00.000Z',
    endsAt: '2026-11-14T19:00:00.000Z',
    venue: 'Casa do Bairro',
    neighbourhood: 'Arroios',
    isOnline: false,
    imageUrl: null,
  };

  describe('listFlashDayEventOptions', () => {
    it('lists no flash day options for an unlinked persona', async () => {
      await expect(
        service.listFlashDayEventOptions('creator-1', {
          userId: 'creator-1',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        }),
      ).resolves.toEqual([]);
      expect(events.find).not.toHaveBeenCalled();
      expect(events.createQueryBuilder).not.toHaveBeenCalled();
      expect(eventCohosts.find).not.toHaveBeenCalled();
    });

    it('lists flash day options without reading RSVPs and from public events only', async () => {
      const eventQuery = makeQueryBuilderStub([makeFlashDayEventRow()]);
      events.createQueryBuilder.mockReturnValue(eventQuery);
      events.find.mockResolvedValue([{ id: 'event-1' }]);
      eventLineupEntries.find.mockResolvedValue([{ eventId: 'event-2' }]);

      const options = await service.listFlashDayEventOptions('creator-1', {
        userId: 'creator-1',
        linkVisibility: SubprofileLinkVisibility.Linked,
      });

      expect(options).toEqual([flashDayArroiosRef]);
      expect(JSON.stringify(options)).not.toContain('Rua Secreta 1');
      expect(JSON.stringify(options)).not.toContain('ring twice');
      expect(eventRsvps.find).not.toHaveBeenCalled();
      expect(eventQuery.where).toHaveBeenCalledWith(
        'event.id IN (:...candidateEventIds)',
        { candidateEventIds: ['event-1', 'event-2'] },
      );
      expect(eventQuery.andWhere).toHaveBeenCalledWith(
        'event.status = :published',
        { published: EventStatus.Published },
      );
      expect(eventQuery.andWhere).toHaveBeenCalledWith(
        'event.visibility = :public',
        { public: EventVisibility.Public },
      );
      expect(eventQuery.andWhere).not.toHaveBeenCalledWith(
        'event.visibility != :inviteOnly',
        expect.anything(),
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        eventQuery,
        'creator-1',
        '"event"."host_id"',
      );
      expect(eventQuery.take).toHaveBeenCalledWith(
        MAX_AFFILIATION_OPTIONS_PER_TYPE,
      );
    });

    it('keeps the "Part of" picker on going RSVPs and the invite-only filter', async () => {
      communities.createQueryBuilder.mockReturnValue(makeQueryBuilderStub([]));
      const eventQuery = makeQueryBuilderStub([]);
      events.createQueryBuilder.mockReturnValue(eventQuery);
      eventRsvps.find.mockResolvedValue([{ eventId: 'event-1' }]);

      await service.listOptions('creator-1', 'creator-1');

      expect(eventRsvps.find).toHaveBeenCalledWith({
        where: { userId: 'creator-1', status: RsvpStatus.Going },
        select: { eventId: true },
      });
      expect(eventQuery.andWhere).toHaveBeenCalledWith(
        'event.visibility != :inviteOnly',
        { inviteOnly: EventVisibility.InviteOnly },
      );
      expect(eventQuery.andWhere).not.toHaveBeenCalledWith(
        'event.visibility = :public',
        expect.anything(),
      );
    });
  });

  describe('eligibleFlashDayEventSlugs', () => {
    const persona = { id: 'persona-1', userId: 'creator-1' };

    beforeEach(() => {
      jest
        .spyOn(service, 'ownerIdsFor')
        .mockResolvedValue(
          new Map([['persona-1', ['creator-1', 'co-owner-2']]]),
        );
    });

    it('counts an event a co-owner hosts as eligible for the persona', async () => {
      events.find.mockResolvedValue([makeFlashDayEventRow()]);

      const eligibleSlugs = await service.eligibleFlashDayEventSlugs(persona, [
        ' flash-day-arroios ',
      ]);

      expect(eligibleSlugs).toEqual(new Set(['flash-day-arroios']));
      expect(events.find).toHaveBeenCalledTimes(1);
      expect(events.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: In(['flash-day-arroios']) },
        }),
      );
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('creator-1', [
        'co-owner-2',
      ]);
      expect(eventRsvps.find).not.toHaveBeenCalled();
    });

    it('counts an accepted lineup act among the owners', async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ hostId: 'someone-else' }),
      ]);
      eventLineupEntries.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'creator-1' },
      ]);

      await expect(
        service.eligibleFlashDayEventSlugs(persona, ['flash-day-arroios']),
      ).resolves.toEqual(new Set(['flash-day-arroios']));
    });

    it("refuses an event the owners only RSVP'd going to", async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ hostId: 'someone-else' }),
      ]);
      eventRsvps.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'creator-1' },
      ]);

      await expect(
        service.eligibleFlashDayEventSlugs(persona, ['flash-day-arroios']),
      ).resolves.toEqual(new Set());
      expect(eventRsvps.find).not.toHaveBeenCalled();
    });

    it('refuses a members-only event', async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ visibility: EventVisibility.Members }),
      ]);

      await expect(
        service.eligibleFlashDayEventSlugs(persona, ['flash-day-arroios']),
      ).resolves.toEqual(new Set());
    });

    it('refuses a cancelled event', async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ status: EventStatus.Cancelled }),
      ]);

      await expect(
        service.eligibleFlashDayEventSlugs(persona, ['flash-day-arroios']),
      ).resolves.toEqual(new Set());
    });

    it('refuses an unknown slug', async () => {
      events.find.mockResolvedValue([]);

      await expect(
        service.eligibleFlashDayEventSlugs(persona, ['no-such-event']),
      ).resolves.toEqual(new Set());
    });

    it('refuses an event whose host the persona creator blocked', async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ hostId: 'host-3' }),
      ]);
      eventCohosts.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'creator-1' },
      ]);
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['host-3']));

      await expect(
        service.eligibleFlashDayEventSlugs(persona, ['flash-day-arroios']),
      ).resolves.toEqual(new Set());
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('creator-1', [
        'host-3',
      ]);
    });

    it('runs no query for blank slugs', async () => {
      await expect(
        service.eligibleFlashDayEventSlugs(persona, ['', '   ']),
      ).resolves.toEqual(new Set());
      expect(events.find).not.toHaveBeenCalled();
    });
  });

  describe('resolveFlashDayEvents', () => {
    const linkedPersona = {
      id: 'persona-1',
      userId: 'creator-1',
      linkVisibility: SubprofileLinkVisibility.Linked,
    };
    const flashDayItem = {
      id: 'item-1',
      subprofileId: 'persona-1',
      section: SubprofileSection.FlashDays,
      structured: { flashDay: { eventSlug: 'flash-day-arroios' } },
    };

    let ownerIdsForSpy: jest.SpyInstance;

    beforeEach(() => {
      ownerIdsForSpy = jest.spyOn(service, 'ownerIdsFor').mockResolvedValue(
        new Map([
          ['persona-1', ['creator-1', 'co-owner-2']],
          ['persona-2', ['creator-2']],
        ]),
      );
    });

    it('resolves a flash day linked to an event a co-owner hosts', async () => {
      events.find.mockResolvedValue([makeFlashDayEventRow()]);

      const linkedEventByItemId = await service.resolveFlashDayEvents(
        'viewer-1',
        [linkedPersona],
        [flashDayItem],
      );

      expect(linkedEventByItemId).toEqual(
        new Map([['item-1', flashDayArroiosRef]]),
      );
      expect(JSON.stringify(linkedEventByItemId.get('item-1'))).not.toContain(
        'Rua Secreta 1',
      );
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('viewer-1', [
        'co-owner-2',
      ]);
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('creator-1', [
        'co-owner-2',
      ]);
      expect(eventRsvps.find).not.toHaveBeenCalled();
    });

    it('drops a linked event that turned members-only', async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ visibility: EventVisibility.Members }),
      ]);

      const linkedEventByItemId = await service.resolveFlashDayEvents(
        'viewer-1',
        [linkedPersona],
        [flashDayItem],
      );

      expect(linkedEventByItemId.has('item-1')).toBe(false);
      expect(linkedEventByItemId.size).toBe(0);
    });

    it('drops every link of an unlinked persona', async () => {
      events.find.mockResolvedValue([makeFlashDayEventRow()]);

      const linkedEventByItemId = await service.resolveFlashDayEvents(
        'viewer-1',
        [
          {
            ...linkedPersona,
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          },
        ],
        [flashDayItem],
      );

      expect(linkedEventByItemId.size).toBe(0);
      expect(events.find).not.toHaveBeenCalled();
    });

    it('drops a link whose host blocked the viewer', async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ hostId: 'host-3' }),
      ]);
      eventLineupEntries.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'creator-1' },
      ]);
      blockFilter.blockedUserIds.mockImplementation((actorId: string) =>
        Promise.resolve(
          actorId === 'viewer-1' ? new Set(['host-3']) : new Set<string>(),
        ),
      );

      const linkedEventByItemId = await service.resolveFlashDayEvents(
        'viewer-1',
        [linkedPersona],
        [flashDayItem],
      );

      expect(linkedEventByItemId.size).toBe(0);
    });

    it('drops a link no owner hosts, co-hosts or plays', async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow({ hostId: 'someone-else' }),
      ]);
      eventRsvps.find.mockResolvedValue([
        { eventId: 'event-1', userId: 'creator-1' },
      ]);

      const linkedEventByItemId = await service.resolveFlashDayEvents(
        'viewer-1',
        [linkedPersona],
        [flashDayItem],
      );

      expect(linkedEventByItemId.size).toBe(0);
      expect(eventRsvps.find).not.toHaveBeenCalled();
    });

    it("resolves two personas' flash days with one events query", async () => {
      events.find.mockResolvedValue([
        makeFlashDayEventRow(),
        makeFlashDayEventRow({
          id: 'event-2',
          slug: 'flash-day-porto',
          title: 'Flash Day in Porto',
          hostId: 'creator-2',
        }),
      ]);

      const linkedEventByItemId = await service.resolveFlashDayEvents(
        'viewer-1',
        [
          linkedPersona,
          {
            id: 'persona-2',
            userId: 'creator-2',
            linkVisibility: SubprofileLinkVisibility.Linked,
          },
        ],
        [
          flashDayItem,
          {
            id: 'item-2',
            subprofileId: 'persona-2',
            section: SubprofileSection.FlashDays,
            structured: { flashDay: { eventSlug: 'flash-day-porto' } },
          },
          // Another section carrying the same key is no flash day link.
          {
            id: 'item-3',
            subprofileId: 'persona-2',
            section: SubprofileSection.Gigs,
            structured: { flashDay: { eventSlug: 'flash-day-arroios' } },
          },
        ],
      );

      expect(events.find).toHaveBeenCalledTimes(1);
      expect(events.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: In(['flash-day-arroios', 'flash-day-porto']) },
        }),
      );
      expect([...linkedEventByItemId.keys()]).toEqual(['item-1', 'item-2']);
      expect(linkedEventByItemId.get('item-2')).toEqual(
        expect.objectContaining({
          slug: 'flash-day-porto',
          title: 'Flash Day in Porto',
        }),
      );
      // The viewer plus one lookup per distinct persona creator.
      expect(blockFilter.blockedUserIds).toHaveBeenCalledTimes(3);
      expect(ownerIdsForSpy).toHaveBeenCalledTimes(1);
      expect(eventCohosts.find).toHaveBeenCalledTimes(1);
    });

    it('runs no query when no item links an event', async () => {
      const linkedEventByItemId = await service.resolveFlashDayEvents(
        'viewer-1',
        [linkedPersona],
        [{ ...flashDayItem, structured: { flashDay: { eventSlug: ' ' } } }],
      );

      expect(linkedEventByItemId.size).toBe(0);
      expect(events.find).not.toHaveBeenCalled();
      expect(blockFilter.blockedUserIds).not.toHaveBeenCalled();
    });
  });
});
