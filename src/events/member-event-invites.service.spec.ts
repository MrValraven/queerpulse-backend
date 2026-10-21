import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { EventAudienceGateService } from './event-audience-gate.service';
import {
  EVENT_INVITE_REQUEST_DECLINED,
  EVENT_INVITE_REQUESTED,
  EVENT_INVITED,
} from './event.events';
import { EventBan } from './entities/event-ban.entity';
import { EventCohost } from './entities/event-cohost.entity';
import {
  EventInvite,
  EventInviteSource,
  EventInviteStatus,
} from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { EventsService } from './events.service';
import {
  RSVP_GUEST_CAP_MESSAGE,
  RSVPS_CLOSED_MESSAGE,
} from './gathering-extras';
import { MemberEventInvitesService } from './member-event-invites.service';

const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;
const INVITER_ID = 'inviter';
const HOST_ID = 'host';
const COHOST_ID = 'cohost';
const INVITEE_ID = 'u-ana';
const INVITEE_SLUG = 'ana';
const CREATED_AT = new Date('2026-10-21T10:00:00Z');

interface ManagerState {
  event: Record<string, unknown> | null;
  inviterRsvp: Record<string, unknown> | null;
  profiles: { userId: string; slug: string }[];
  activeUsers: { id: string }[];
  existingRows: Record<string, unknown>[];
  bans: { userId: string }[];
  candidateRsvps: Record<string, unknown>[];
  cohosts: { userId: string }[];
  openInviteCount: number;
  reviveAffected: number;
  isInsertIgnored: boolean;
  isInviteeActive: boolean;
  isInviteeBanned: boolean;
}

/** One conditional write the create transaction ran through its query builder. */
interface WriteRecord {
  kind: 'update' | 'insert';
  set: Record<string, unknown> | null;
  values: Record<string, unknown>[];
  conditions: unknown[][];
}

interface UpdateBuilderMock {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  execute: jest.Mock;
}

function buildEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'e1',
    slug: 'supper',
    title: 'Supper',
    status: EventStatus.Published,
    visibility: EventVisibility.Public,
    hostId: HOST_ID,
    startAt: new Date(Date.now() + 72 * HOUR_IN_MILLISECONDS),
    endAt: null,
    rsvpCutoff: null,
    ...overrides,
  };
}

describe('MemberEventInvitesService', () => {
  let service: MemberEventInvitesService;
  let state: ManagerState;
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    exists: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let writes: WriteRecord[];
  let updateBuilder: UpdateBuilderMock;
  let invites: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let events: { findOne: jest.Mock };
  let rsvps: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock };
  let audienceGate: { audienceAmong: jest.Mock; assertViewable: jest.Mock };
  let connectionsService: { acceptedConnectionsAmong: jest.Mock };
  let blockFilter: { blockedUserIds: jest.Mock };
  let emitter: { emit: jest.Mock };
  let connectedIds: Set<string>;
  let blockedWithInviter: Set<string>;
  let blockedWithHost: Set<string>;
  let audienceViewerIds: Set<string>;

  beforeEach(async () => {
    state = {
      event: buildEvent(),
      inviterRsvp: { status: RsvpStatus.Going, guestCount: 0 },
      profiles: [{ userId: INVITEE_ID, slug: INVITEE_SLUG }],
      activeUsers: [{ id: INVITEE_ID }],
      existingRows: [],
      bans: [],
      candidateRsvps: [],
      cohosts: [{ userId: COHOST_ID }],
      openInviteCount: 0,
      reviveAffected: 1,
      isInsertIgnored: false,
      isInviteeActive: true,
      isInviteeBanned: false,
    };
    writes = [];
    connectedIds = new Set([INVITEE_ID]);
    blockedWithInviter = new Set();
    blockedWithHost = new Set();
    audienceViewerIds = new Set([INVITEE_ID]);

    manager = {
      findOne: jest.fn((entity: unknown) => {
        if (entity === Event) return Promise.resolve(state.event);
        if (entity === EventRsvp) return Promise.resolve(state.inviterRsvp);
        return Promise.resolve(null);
      }),
      find: jest.fn((entity: unknown) => {
        if (entity === Profile) return Promise.resolve(state.profiles);
        if (entity === User) return Promise.resolve(state.activeUsers);
        if (entity === EventInvite) return Promise.resolve(state.existingRows);
        if (entity === EventBan) return Promise.resolve(state.bans);
        if (entity === EventRsvp) return Promise.resolve(state.candidateRsvps);
        if (entity === EventCohost) return Promise.resolve(state.cohosts);
        return Promise.resolve([]);
      }),
      count: jest.fn(() => Promise.resolve(state.openInviteCount)),
      exists: jest.fn((entity: unknown) => {
        if (entity === User) return Promise.resolve(state.isInviteeActive);
        if (entity === EventBan) return Promise.resolve(state.isInviteeBanned);
        return Promise.resolve(false);
      }),
      createQueryBuilder: jest.fn(() => {
        const record: WriteRecord = {
          kind: 'update',
          set: null,
          values: [],
          conditions: [],
        };
        writes.push(record);
        const builder: Record<string, jest.Mock> = {};
        const chain = (): Record<string, jest.Mock> => builder;
        builder.update = jest.fn(chain);
        builder.into = jest.fn(chain);
        builder.orIgnore = jest.fn(chain);
        builder.returning = jest.fn(chain);
        builder.insert = jest.fn(() => {
          record.kind = 'insert';
          return builder;
        });
        builder.set = jest.fn((values: Record<string, unknown>) => {
          record.set = values;
          return builder;
        });
        builder.values = jest.fn((rows: Record<string, unknown>[]) => {
          record.values = rows;
          return builder;
        });
        builder.where = jest.fn((...args: unknown[]) => {
          record.conditions.push(args);
          return builder;
        });
        builder.andWhere = jest.fn((...args: unknown[]) => {
          record.conditions.push(args);
          return builder;
        });
        builder.execute = jest.fn(() =>
          Promise.resolve(
            record.kind === 'insert'
              ? {
                  raw: state.isInsertIgnored
                    ? []
                    : record.values.map((row, index) => ({
                        id: `new-${index}`,
                        invitee_id: row.inviteeId,
                        created_at: CREATED_AT,
                      })),
                }
              : { affected: state.reviveAffected },
          ),
        );
        return builder;
      }),
    };
    const dataSource = {
      transaction: jest.fn((work: (txManager: typeof manager) => unknown) =>
        work(manager),
      ),
      manager,
    };

    updateBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    updateBuilder.update.mockReturnValue(updateBuilder);
    updateBuilder.set.mockReturnValue(updateBuilder);
    updateBuilder.where.mockReturnValue(updateBuilder);
    updateBuilder.andWhere.mockReturnValue(updateBuilder);

    invites = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => updateBuilder),
    };
    events = { findOne: jest.fn().mockResolvedValue(buildEvent()) };
    rsvps = { find: jest.fn().mockResolvedValue([]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    eventsService = { isOrganizer: jest.fn().mockResolvedValue(false) };
    audienceGate = {
      audienceAmong: jest.fn(() =>
        Promise.resolve({
          organizerUserIds: new Set<string>(),
          viewerUserIds: audienceViewerIds,
        }),
      ),
      assertViewable: jest.fn().mockResolvedValue(undefined),
    };
    connectionsService = {
      acceptedConnectionsAmong: jest.fn(() => Promise.resolve(connectedIds)),
    };
    blockFilter = {
      blockedUserIds: jest.fn((actorId: string) => {
        if (actorId === INVITER_ID) return Promise.resolve(blockedWithInviter);
        if (actorId === HOST_ID) return Promise.resolve(blockedWithHost);
        return Promise.resolve(new Set<string>());
      }),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemberEventInvitesService,
        { provide: DataSource, useValue: dataSource },
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: EventsService, useValue: eventsService },
        { provide: EventAudienceGateService, useValue: audienceGate },
        { provide: ConnectionsService, useValue: connectionsService },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(MemberEventInvitesService);
  });

  const invite = () =>
    service.createMemberInvites('supper', INVITER_ID, [INVITEE_SLUG]);

  describe('createMemberInvites', () => {
    it('takes the event pessimistic_write lock', async () => {
      await invite();
      expect(manager.findOne).toHaveBeenCalledWith(Event, {
        where: { slug: 'supper' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('refuses an inviter without a going or maybe RSVP', async () => {
      state.inviterRsvp = { status: RsvpStatus.Waitlisted, guestCount: 0 };
      await expect(invite()).rejects.toBeInstanceOf(ForbiddenException);
      state.inviterRsvp = null;
      await expect(invite()).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses after the cutoff', async () => {
      state.event = buildEvent({
        startAt: new Date(Date.now() + 2 * HOUR_IN_MILLISECONDS),
        rsvpCutoff: 'day-before',
      });
      await expect(invite()).rejects.toThrow(RSVPS_CLOSED_MESSAGE);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses a draft or ended event', async () => {
      state.event = buildEvent({ status: EventStatus.Draft });
      await expect(invite()).rejects.toBeInstanceOf(BadRequestException);
      state.event = buildEvent({
        startAt: new Date(Date.now() - 2 * HOUR_IN_MILLISECONDS),
      });
      await expect(invite()).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    describe('identical refusal reason', () => {
      const scenarios: [string, () => void][] = [
        [
          'a non-connection',
          () => {
            connectedIds = new Set();
          },
        ],
        [
          'a block either way with the inviter',
          () => {
            blockedWithInviter = new Set([INVITEE_ID]);
          },
        ],
        [
          'a block with the host',
          () => {
            blockedWithHost = new Set([INVITEE_ID]);
          },
        ],
        [
          'a ban',
          () => {
            state.bans = [{ userId: INVITEE_ID }];
          },
        ],
        [
          'a live RSVP',
          () => {
            state.candidateRsvps = [
              {
                userId: INVITEE_ID,
                status: RsvpStatus.Going,
                removedByHostAt: null,
              },
            ];
          },
        ],
        [
          'a host removal (removedByHostAt)',
          () => {
            state.candidateRsvps = [
              {
                userId: INVITEE_ID,
                status: RsvpStatus.Cancelled,
                removedByHostAt: new Date(),
              },
            ];
          },
        ],
        [
          'an earlier declined row',
          () => {
            state.existingRows = [
              {
                id: 'i1',
                inviteeId: INVITEE_ID,
                status: EventInviteStatus.Declined,
              },
            ];
          },
        ],
        [
          'an accepted row whose invitee cancelled their RSVP',
          () => {
            state.existingRows = [
              {
                id: 'i1',
                inviteeId: INVITEE_ID,
                status: EventInviteStatus.Accepted,
              },
            ];
            state.candidateRsvps = [
              {
                userId: INVITEE_ID,
                status: RsvpStatus.Cancelled,
                removedByHostAt: null,
              },
            ];
          },
        ],
        [
          'an accepted row whose invitee holds no RSVP row',
          () => {
            state.existingRows = [
              {
                id: 'i1',
                inviteeId: INVITEE_ID,
                status: EventInviteStatus.Accepted,
              },
            ];
          },
        ],
        [
          'an audience miss on a network event',
          () => {
            state.event = buildEvent({ visibility: EventVisibility.Network });
            audienceViewerIds = new Set();
          },
        ],
        [
          'an inactive account',
          () => {
            state.activeUsers = [];
          },
        ],
      ];

      it.each(scenarios)('%s reads not_invitable', async (_label, arrange) => {
        arrange();
        await expect(invite()).resolves.toEqual({
          invites: [],
          refused: [{ slug: INVITEE_SLUG, reason: 'not_invitable' }],
        });
        expect(manager.createQueryBuilder).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });
    });

    it.each([EventInviteStatus.Pending, EventInviteStatus.AwaitingHost])(
      'open row (%s) gives already_invited',
      async (status) => {
        state.existingRows = [{ id: 'i1', inviteeId: INVITEE_ID, status }];
        await expect(invite()).resolves.toEqual({
          invites: [],
          refused: [{ slug: INVITEE_SLUG, reason: 'already_invited' }],
        });
        expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      },
    );

    it.each([EventInviteStatus.Withdrawn, EventInviteStatus.HostDeclined])(
      'revives a %s row with the new inviter and source member',
      async (status) => {
        state.existingRows = [
          {
            id: 'i1',
            inviteeId: INVITEE_ID,
            inviterId: 'someone-else',
            source: EventInviteSource.Host,
            status,
            createdAt: CREATED_AT,
          },
        ];
        const result = await invite();
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual({
          kind: 'update',
          set: {
            inviterId: INVITER_ID,
            source: EventInviteSource.Member,
            status: EventInviteStatus.Pending,
            createdAt: expect.any(Date) as unknown,
          },
          values: [],
          conditions: [
            ['id = :inviteId', { inviteId: 'i1' }],
            [
              'status IN (:...reinvitableStatuses)',
              {
                reinvitableStatuses: [
                  EventInviteStatus.Withdrawn,
                  EventInviteStatus.HostDeclined,
                ],
              },
            ],
          ],
        });
        expect(result.invites).toEqual([
          expect.objectContaining({ id: 'i1', status: 'invited' }),
        ]);
        expect(result.invites[0]?.createdAt).not.toBe(CREATED_AT);
      },
    );

    it('invite_only gives awaiting_host, emits EVENT_INVITE_REQUESTED with host plus co-host ids and no EVENT_INVITED', async () => {
      state.event = buildEvent({ visibility: EventVisibility.InviteOnly });
      const result = await invite();
      expect(audienceGate.audienceAmong).not.toHaveBeenCalled();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.kind).toBe('insert');
      expect(writes[0]?.values).toEqual([
        {
          eventId: 'e1',
          inviteeId: INVITEE_ID,
          inviterId: INVITER_ID,
          source: EventInviteSource.Member,
          status: EventInviteStatus.AwaitingHost,
        },
      ]);
      expect(result.invites).toEqual([
        expect.objectContaining({
          status: 'awaiting_host',
          canWithdraw: true,
        }),
      ]);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITE_REQUESTED,
        expect.objectContaining({
          eventId: 'e1',
          eventSlug: 'supper',
          eventTitle: 'Supper',
          inviterId: INVITER_ID,
          inviteeId: INVITEE_ID,
          organiserIds: expect.arrayContaining([HOST_ID, COHOST_ID]) as unknown,
        }),
      );
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITED,
        expect.anything(),
      );
    });

    it('open audience gives pending and EVENT_INVITED with eventSlug', async () => {
      const result = await invite();
      expect(result.invites).toEqual([
        expect.objectContaining({ id: 'new-0', status: 'invited' }),
      ]);
      expect(emitter.emit).toHaveBeenCalledWith(EVENT_INVITED, {
        eventId: 'e1',
        eventSlug: 'supper',
        inviteId: 'new-0',
        inviterId: INVITER_ID,
        inviteeId: INVITEE_ID,
      });
    });

    it("an organiser's own invite on invite_only goes straight to pending", async () => {
      state.event = buildEvent({ visibility: EventVisibility.InviteOnly });
      state.inviterRsvp = null;
      eventsService.isOrganizer.mockResolvedValue(true);
      await invite();
      expect(writes[0]?.values).toEqual([
        expect.objectContaining({ status: EventInviteStatus.Pending }),
      ]);
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITED,
        expect.objectContaining({ inviteeId: INVITEE_ID }),
      );
    });

    it('cap: guestCount 2 plus 1 open plus 1 new is a 400 RSVP_GUEST_CAP_MESSAGE and writes nothing', async () => {
      state.inviterRsvp = { status: RsvpStatus.Going, guestCount: 2 };
      state.openInviteCount = 1;
      await expect(invite()).rejects.toThrow(
        new BadRequestException(RSVP_GUEST_CAP_MESSAGE),
      );
      expect(manager.count).toHaveBeenCalledWith(EventInvite, {
        where: expect.objectContaining({
          eventId: 'e1',
          inviterId: INVITER_ID,
          source: EventInviteSource.Member,
        }) as unknown,
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('createMemberInvites hardening', () => {
    it('refuses a self-invite as not_invitable and leaves it out of the cap', async () => {
      state.profiles = [{ userId: INVITER_ID, slug: 'me' }];
      state.inviterRsvp = { status: RsvpStatus.Going, guestCount: 3 };
      await expect(
        service.createMemberInvites('supper', INVITER_ID, ['me']),
      ).resolves.toEqual({
        invites: [],
        refused: [{ slug: 'me', reason: 'not_invitable' }],
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it.each([
      ['the host', HOST_ID],
      ['a co-host', COHOST_ID],
    ])('refuses %s as not_invitable', async (_label, organiserId) => {
      state.profiles = [{ userId: organiserId, slug: 'organiser' }];
      state.activeUsers = [{ id: organiserId }];
      connectedIds = new Set([organiserId]);
      audienceViewerIds = new Set([organiserId]);
      await expect(
        service.createMemberInvites('supper', INVITER_ID, ['organiser']),
      ).resolves.toEqual({
        invites: [],
        refused: [{ slug: 'organiser', reason: 'not_invitable' }],
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('checks the cap before eligibility: guestCount 3 plus a hidden attendee is still a 400', async () => {
      state.inviterRsvp = { status: RsvpStatus.Going, guestCount: 3 };
      state.candidateRsvps = [
        {
          userId: INVITEE_ID,
          status: RsvpStatus.Going,
          visibility: 'justMe',
          removedByHostAt: null,
        },
      ];
      await expect(invite()).rejects.toThrow(
        new BadRequestException(RSVP_GUEST_CAP_MESSAGE),
      );
      expect(
        connectionsService.acceptedConnectionsAmong,
      ).not.toHaveBeenCalled();
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses an unknown slug as not_invitable', async () => {
      await expect(
        service.createMemberInvites('supper', INVITER_ID, ['nobody']),
      ).resolves.toEqual({
        invites: [],
        refused: [{ slug: 'nobody', reason: 'not_invitable' }],
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('a revive lost to a concurrent write reads already_invited and emits nothing', async () => {
      state.existingRows = [
        {
          id: 'i1',
          inviteeId: INVITEE_ID,
          status: EventInviteStatus.Withdrawn,
        },
      ];
      state.reviveAffected = 0;
      await expect(invite()).resolves.toEqual({
        invites: [],
        refused: [{ slug: INVITEE_SLUG, reason: 'already_invited' }],
      });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('an insert skipped by orIgnore reads already_invited and emits nothing', async () => {
      state.isInsertIgnored = true;
      await expect(invite()).resolves.toEqual({
        invites: [],
        refused: [{ slug: INVITEE_SLUG, reason: 'already_invited' }],
      });
      expect(writes[0]?.kind).toBe('insert');
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    it('withdraw by a non-inviter is a 404, a non-open invite is a 409, an open one becomes withdrawn', async () => {
      invites.findOne.mockResolvedValue({
        id: 'i1',
        inviterId: 'someone-else',
        source: EventInviteSource.Member,
        status: EventInviteStatus.Pending,
      });
      await expect(service.withdraw('i1', INVITER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      invites.findOne.mockResolvedValue({
        id: 'i1',
        inviterId: INVITER_ID,
        source: EventInviteSource.Host,
        status: EventInviteStatus.Pending,
      });
      await expect(service.withdraw('i1', INVITER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(updateBuilder.execute).not.toHaveBeenCalled();

      invites.findOne.mockResolvedValue({
        id: 'i1',
        inviterId: INVITER_ID,
        source: EventInviteSource.Member,
        status: EventInviteStatus.Accepted,
      });
      updateBuilder.execute.mockResolvedValueOnce({ affected: 0 });
      await expect(service.withdraw('i1', INVITER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );

      invites.findOne.mockResolvedValue({
        id: 'i1',
        inviterId: INVITER_ID,
        source: EventInviteSource.Member,
        status: EventInviteStatus.Pending,
      });
      await expect(service.withdraw('i1', INVITER_ID)).resolves.toEqual({
        id: 'i1',
        status: EventInviteStatus.Withdrawn,
      });
      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: EventInviteStatus.Withdrawn,
      });
      expect(updateBuilder.andWhere).toHaveBeenCalledWith('source = :member', {
        member: EventInviteSource.Member,
      });
      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'status IN (:...openStatuses)',
        {
          openStatuses: [
            EventInviteStatus.Pending,
            EventInviteStatus.AwaitingHost,
          ],
        },
      );
    });
  });

  describe('host approval', () => {
    const request = {
      id: 'i1',
      eventId: 'e1',
      inviterId: INVITER_ID,
      inviteeId: INVITEE_ID,
      status: EventInviteStatus.AwaitingHost,
    };

    it('approve and decline by a non-organiser are a 403', async () => {
      invites.findOne.mockResolvedValue(request);
      eventsService.isOrganizer.mockResolvedValue(false);
      await expect(service.approve('i1', 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        service.declineRequest('i1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(eventsService.isOrganizer).toHaveBeenCalledWith('e1', 'stranger');
      expect(updateBuilder.execute).not.toHaveBeenCalled();
    });

    it('approve flips awaiting_host to pending and emits EVENT_INVITED with the member inviter', async () => {
      invites.findOne.mockResolvedValue(request);
      eventsService.isOrganizer.mockResolvedValue(true);
      await expect(service.approve('i1', HOST_ID)).resolves.toEqual({
        id: 'i1',
        status: EventInviteStatus.Pending,
      });
      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: EventInviteStatus.Pending,
      });
      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'status IN (:...awaitingStatuses)',
        { awaitingStatuses: [EventInviteStatus.AwaitingHost] },
      );
      expect(emitter.emit).toHaveBeenCalledWith(EVENT_INVITED, {
        eventId: 'e1',
        eventSlug: 'supper',
        inviteId: 'i1',
        inviterId: INVITER_ID,
        inviteeId: INVITEE_ID,
      });
    });

    it('approve on a request already decided is a 409 and emits nothing', async () => {
      invites.findOne.mockResolvedValue(request);
      eventsService.isOrganizer.mockResolvedValue(true);
      updateBuilder.execute.mockResolvedValueOnce({ affected: 0 });
      await expect(service.approve('i1', HOST_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    const refusedApprovals: [string, () => void][] = [
      [
        'an unpublished event',
        () => {
          events.findOne.mockResolvedValue(
            buildEvent({ status: EventStatus.Cancelled }),
          );
        },
      ],
      [
        'an ended event',
        () => {
          events.findOne.mockResolvedValue(
            buildEvent({
              startAt: new Date(Date.now() - 2 * HOUR_IN_MILLISECONDS),
            }),
          );
        },
      ],
      [
        'an invitee banned since the request',
        () => {
          state.isInviteeBanned = true;
        },
      ],
      [
        'an inactive invitee',
        () => {
          state.isInviteeActive = false;
        },
      ],
      [
        'a block with the inviter',
        () => {
          blockedWithInviter = new Set([INVITEE_ID]);
        },
      ],
      [
        'a block with the host',
        () => {
          blockedWithHost = new Set([INVITEE_ID]);
        },
      ],
    ];

    it.each(refusedApprovals)(
      'approve on %s is a neutral 409 that moves nothing and emits no EVENT_INVITED',
      async (_label, arrange) => {
        invites.findOne.mockResolvedValue(request);
        eventsService.isOrganizer.mockResolvedValue(true);
        arrange();
        await expect(service.approve('i1', HOST_ID)).rejects.toThrow(
          new ConflictException('This request can no longer be approved'),
        );
        expect(updateBuilder.execute).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    it('approve when the invitee RSVPed while the request waited is a neutral 409 that emits nothing', async () => {
      invites.findOne.mockResolvedValue(request);
      eventsService.isOrganizer.mockResolvedValue(true);
      manager.exists.mockImplementation(
        (entity: unknown, options: { where: Record<string, unknown> }) => {
          if (entity === User) return Promise.resolve(true);
          if (entity === EventRsvp) {
            expect(options.where).toEqual(
              expect.objectContaining({ eventId: 'e1', userId: INVITEE_ID }),
            );
            return Promise.resolve(true);
          }
          return Promise.resolve(false);
        },
      );
      await expect(service.approve('i1', HOST_ID)).rejects.toThrow(
        new ConflictException('This request can no longer be approved'),
      );
      expect(updateBuilder.execute).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('decline flips to host_declined and emits EVENT_INVITE_REQUEST_DECLINED', async () => {
      invites.findOne.mockResolvedValue(request);
      eventsService.isOrganizer.mockResolvedValue(true);
      await expect(service.declineRequest('i1', HOST_ID)).resolves.toEqual({
        id: 'i1',
        status: EventInviteStatus.HostDeclined,
      });
      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: EventInviteStatus.HostDeclined,
      });
      expect(emitter.emit).toHaveBeenCalledWith(EVENT_INVITE_REQUEST_DECLINED, {
        eventId: 'e1',
        eventSlug: 'supper',
        eventTitle: 'Supper',
        inviteId: 'i1',
        inviterId: INVITER_ID,
      });
    });
  });

  describe('listRequests', () => {
    it('listRequests returns awaiting_host only', async () => {
      eventsService.isOrganizer.mockResolvedValue(true);
      invites.find.mockResolvedValue([
        {
          id: 'i1',
          eventId: 'e1',
          inviterId: INVITER_ID,
          inviteeId: INVITEE_ID,
          status: EventInviteStatus.AwaitingHost,
          createdAt: CREATED_AT,
        },
      ]);
      profiles.find.mockResolvedValue([
        { userId: INVITER_ID, slug: 'inviter-slug', firstName: 'Ina' },
        { userId: INVITEE_ID, slug: INVITEE_SLUG, firstName: 'Ana' },
      ]);
      const result = await service.listRequests('supper', HOST_ID);
      expect(invites.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'e1', status: EventInviteStatus.AwaitingHost },
        }),
      );
      expect(result).toEqual([
        expect.objectContaining({
          id: 'i1',
          inviter: expect.objectContaining({ slug: 'inviter-slug' }) as unknown,
          invitee: expect.objectContaining({ slug: INVITEE_SLUG }) as unknown,
        }),
      ]);
    });

    it('refuses a non-organiser', async () => {
      eventsService.isOrganizer.mockResolvedValue(false);
      await expect(
        service.listRequests('supper', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(invites.find).not.toHaveBeenCalled();
    });

    it('listRequests answers a hidden invite_only event with the same 404 as a missing slug', async () => {
      events.findOne.mockResolvedValue(
        buildEvent({ visibility: EventVisibility.InviteOnly }),
      );
      eventsService.isOrganizer.mockResolvedValue(false);
      audienceGate.assertViewable.mockRejectedValue(
        new NotFoundException('Event not found'),
      );
      await expect(service.listRequests('supper', 'stranger')).rejects.toThrow(
        new NotFoundException('Event not found'),
      );
      expect(audienceGate.assertViewable).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'e1' }),
        'stranger',
        false,
      );
      expect(invites.find).not.toHaveBeenCalled();

      events.findOne.mockResolvedValue(null);
      await expect(service.listRequests('nope', 'stranger')).rejects.toThrow(
        new NotFoundException('Event not found'),
      );
    });
  });

  describe('listMyInvites', () => {
    it('listMyInvites answers a hidden invite_only event with the same 404 as a missing slug', async () => {
      events.findOne.mockResolvedValue(
        buildEvent({ visibility: EventVisibility.InviteOnly }),
      );
      audienceGate.assertViewable.mockRejectedValue(
        new NotFoundException('Event not found'),
      );
      await expect(service.listMyInvites('supper', 'stranger')).rejects.toThrow(
        new NotFoundException('Event not found'),
      );
      expect(invites.find).not.toHaveBeenCalled();

      events.findOne.mockResolvedValue(null);
      await expect(service.listMyInvites('nope', 'stranger')).rejects.toThrow(
        new NotFoundException('Event not found'),
      );
    });

    it('listMyInvites omits withdrawn and blocked invitees and computes status server-side', async () => {
      const row = (
        id: string,
        inviteeId: string,
        status: EventInviteStatus,
      ) => ({
        id,
        eventId: 'e1',
        inviterId: INVITER_ID,
        inviteeId,
        source: EventInviteSource.Member,
        status,
        createdAt: CREATED_AT,
      });
      invites.find.mockResolvedValue([
        row('i-going', 'u-going', EventInviteStatus.Accepted),
        row('i-hidden', 'u-hidden', EventInviteStatus.Accepted),
        row('i-declined', 'u-declined', EventInviteStatus.Declined),
        row('i-withdrawn', 'u-withdrawn', EventInviteStatus.Withdrawn),
        row('i-blocked', 'u-blocked', EventInviteStatus.Pending),
        row('i-open', 'u-open', EventInviteStatus.AwaitingHost),
      ]);
      rsvps.find.mockResolvedValue([
        { userId: 'u-going', status: RsvpStatus.Going, visibility: 'everyone' },
        { userId: 'u-hidden', status: RsvpStatus.Going, visibility: 'justMe' },
      ]);
      blockedWithInviter = new Set(['u-blocked']);
      connectedIds = new Set(['u-going', 'u-hidden', 'u-declined', 'u-open']);

      const result = await service.listMyInvites('supper', INVITER_ID);

      expect(
        result.map((view) => [view.id, view.status, view.canWithdraw]),
      ).toEqual([
        ['i-going', 'going', false],
        ['i-hidden', 'answered', false],
        ['i-declined', 'answered', false],
        ['i-open', 'awaiting_host', true],
      ]);
      expect(invites.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            eventId: 'e1',
            inviterId: INVITER_ID,
            source: EventInviteSource.Member,
          },
        }),
      );
    });
  });
});
