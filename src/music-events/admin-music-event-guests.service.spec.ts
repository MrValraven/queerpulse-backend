import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { CheckInDto } from '../events/dto/check-in.dto';
import type { CreateEventBanDto } from '../events/dto/create-event-ban.dto';
import type { InviteEventDto } from '../events/dto/invite-event.dto';
import type { ListAttendeesQuery } from '../events/dto/list-attendees.query';
import { EventBan } from '../events/entities/event-ban.entity';
import type { Event } from '../events/entities/event.entity';
import {
  EventInvite,
  EventInviteStatus,
} from '../events/entities/event-invite.entity';
import { EventBansService } from '../events/event-bans.service';
import { EventCheckInService } from '../events/event-check-in.service';
import { EventInvitesService } from '../events/event-invites.service';
import { EventsService } from '../events/events.service';
import { GatheringFamily } from '../events/gathering-family';
import { houseMusicEventError } from '../events/house-music-event-errors';
import { MemberEventInvitesService } from '../events/member-event-invites.service';
import { RsvpService } from '../events/rsvp.service';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminMusicEventGuestsService } from './admin-music-event-guests.service';
import { HouseMusicEventScopeService } from './house-music-event-scope.service';

const HOUSE_USER_ID = 'house-user-1';
const STAFF_USER_ID = 'staff-user-1';
const EVENT_SLUG = 'friday-set';
const EVENT_TITLE = 'Friday Set';
const INVITE_ID = 'invite-1';

function eventFixture(): Event {
  const fixture: Partial<Event> = {
    id: 'event-1',
    slug: EVENT_SLUG,
    title: EVENT_TITLE,
    hostId: HOUSE_USER_ID,
    gatheringFamily: GatheringFamily.Music,
  };
  return fixture as Event;
}

function inviteFixture(overrides: Partial<EventInvite>): EventInvite {
  const fixture: Partial<EventInvite> = {
    id: INVITE_ID,
    eventId: 'event-1',
    inviterId: 'member-inviter-1',
    inviteeId: 'member-invitee-1',
    status: EventInviteStatus.AwaitingHost,
    ...overrides,
  };
  return fixture as EventInvite;
}

function profileFixture(overrides: Partial<Profile>): Profile {
  const fixture: Partial<Profile> = {
    userId: 'member-1',
    slug: 'ana-silva',
    firstName: 'Ana',
    lastName: 'Silva',
    ...overrides,
  };
  return fixture as Profile;
}

async function expectCode(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(status);
  expect(exception.getResponse()).toMatchObject({ code });
}

describe('AdminMusicEventGuestsService', () => {
  let service: AdminMusicEventGuestsService;
  const loadOrNotFound = jest.fn();
  const eventsServiceMock = { attendees: jest.fn(), attendeesCsv: jest.fn() };
  const rsvpServiceMock = {
    removeAttendee: jest.fn(),
    promoteAttendee: jest.fn(),
  };
  const eventBansServiceMock = {
    ban: jest.fn(),
    lift: jest.fn(),
    list: jest.fn(),
  };
  const eventInvitesServiceMock = { createInvites: jest.fn() };
  const memberEventInvitesServiceMock = {
    listRequests: jest.fn(),
    approve: jest.fn(),
    declineRequest: jest.fn(),
  };
  const eventCheckInServiceMock = {
    checkIn: jest.fn(),
    undoCheckIn: jest.fn(),
  };
  const inviteFindOne = jest.fn();
  const profileFindOne = jest.fn();
  const banExists = jest.fn();
  const auditCreate = jest.fn((row: Partial<ModAuditLog>) => row);
  const auditSave = jest.fn();

  const memberServiceMocks: jest.Mock[] = [
    eventsServiceMock.attendees,
    eventsServiceMock.attendeesCsv,
    rsvpServiceMock.removeAttendee,
    rsvpServiceMock.promoteAttendee,
    eventBansServiceMock.ban,
    eventBansServiceMock.lift,
    eventBansServiceMock.list,
    eventInvitesServiceMock.createInvites,
    memberEventInvitesServiceMock.listRequests,
    memberEventInvitesServiceMock.approve,
    memberEventInvitesServiceMock.declineRequest,
    eventCheckInServiceMock.checkIn,
    eventCheckInServiceMock.undoCheckIn,
    inviteFindOne,
  ];

  function savedAuditRows(): Partial<ModAuditLog>[] {
    return auditSave.mock.calls.map(([row]: [Partial<ModAuditLog>]) => row);
  }

  beforeEach(async () => {
    for (const mock of memberServiceMocks) mock.mockReset();
    profileFindOne.mockReset().mockResolvedValue(profileFixture({}));
    banExists.mockReset().mockResolvedValue(false);
    auditCreate.mockClear();
    auditSave.mockReset().mockResolvedValue(undefined);
    loadOrNotFound.mockReset().mockResolvedValue({
      event: eventFixture(),
      houseUserId: HOUSE_USER_ID,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminMusicEventGuestsService,
        { provide: HouseMusicEventScopeService, useValue: { loadOrNotFound } },
        { provide: EventsService, useValue: eventsServiceMock },
        { provide: RsvpService, useValue: rsvpServiceMock },
        { provide: EventBansService, useValue: eventBansServiceMock },
        { provide: EventInvitesService, useValue: eventInvitesServiceMock },
        {
          provide: MemberEventInvitesService,
          useValue: memberEventInvitesServiceMock,
        },
        { provide: EventCheckInService, useValue: eventCheckInServiceMock },
        {
          provide: getRepositoryToken(EventInvite),
          useValue: { findOne: inviteFindOne },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: { findOne: profileFindOne },
        },
        {
          provide: getRepositoryToken(ModAuditLog),
          useValue: { create: auditCreate, save: auditSave },
        },
        {
          provide: getRepositoryToken(EventBan),
          useValue: { exists: banExists },
        },
      ],
    }).compile();
    service = moduleRef.get(AdminMusicEventGuestsService);
  });

  it('reads the roster as the house with the door filters passed through', async () => {
    const page = { items: [], goingCount: 0 };
    eventsServiceMock.attendees.mockResolvedValue(page);
    const query: ListAttendeesQuery = {
      status: 'going',
      page: 2,
      arrival: 'arrived',
      q: 'ana',
    };

    await expect(service.roster(EVENT_SLUG, query)).resolves.toBe(page);

    expect(loadOrNotFound).toHaveBeenCalledWith(EVENT_SLUG);
    expect(eventsServiceMock.attendees).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      'going',
      2,
      { arrival: 'arrived', q: 'ana' },
    );
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('refuses an invite id from another event with music_event_invite_request_not_found before deciding', async () => {
    inviteFindOne.mockResolvedValue(inviteFixture({ eventId: 'event-other' }));

    await expectCode(
      service.decideInviteRequest(
        STAFF_USER_ID,
        EVENT_SLUG,
        INVITE_ID,
        'approve',
      ),
      404,
      'music_event_invite_request_not_found',
    );

    expect(inviteFindOne).toHaveBeenCalledWith({ where: { id: INVITE_ID } });
    expect(memberEventInvitesServiceMock.approve).not.toHaveBeenCalled();
    expect(memberEventInvitesServiceMock.declineRequest).not.toHaveBeenCalled();
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('refuses an unknown invite id with music_event_invite_request_not_found', async () => {
    inviteFindOne.mockResolvedValue(null);

    await expectCode(
      service.decideInviteRequest(
        STAFF_USER_ID,
        EVENT_SLUG,
        INVITE_ID,
        'decline',
      ),
      404,
      'music_event_invite_request_not_found',
    );

    expect(memberEventInvitesServiceMock.declineRequest).not.toHaveBeenCalled();
  });

  it('approves with the house id and audits the decision', async () => {
    inviteFindOne.mockResolvedValue(inviteFixture({}));
    profileFindOne.mockResolvedValue(
      profileFixture({ userId: 'member-invitee-1' }),
    );
    const decided = { id: INVITE_ID, status: EventInviteStatus.Pending };
    memberEventInvitesServiceMock.approve.mockResolvedValue(decided);

    await expect(
      service.decideInviteRequest(
        STAFF_USER_ID,
        EVENT_SLUG,
        INVITE_ID,
        'approve',
      ),
    ).resolves.toBe(decided);

    expect(memberEventInvitesServiceMock.approve).toHaveBeenCalledWith(
      INVITE_ID,
      HOUSE_USER_ID,
    );
    expect(savedAuditRows()).toEqual([
      {
        reportId: null,
        actorId: STAFF_USER_ID,
        action: 'music_event_invite_decided',
        targetUserId: 'member-invitee-1',
        targetName: 'Ana Silva',
        reasonCode: null,
        note: `${EVENT_SLUG}: approve`,
        duration: null,
      },
    ]);
  });

  it('declines with the house id and audits the decision', async () => {
    inviteFindOne.mockResolvedValue(inviteFixture({}));
    const decided = { id: INVITE_ID, status: EventInviteStatus.HostDeclined };
    memberEventInvitesServiceMock.declineRequest.mockResolvedValue(decided);

    await expect(
      service.decideInviteRequest(
        STAFF_USER_ID,
        EVENT_SLUG,
        INVITE_ID,
        'decline',
      ),
    ).resolves.toBe(decided);

    expect(memberEventInvitesServiceMock.declineRequest).toHaveBeenCalledWith(
      INVITE_ID,
      HOUSE_USER_ID,
    );
    expect(memberEventInvitesServiceMock.approve).not.toHaveBeenCalled();
    expect(savedAuditRows().map((row) => row.note)).toEqual([
      `${EVENT_SLUG}: decline`,
    ]);
  });

  it('writes the bar audit row without the bar reason', async () => {
    const barView = {
      slug: 'ana-silva',
      firstName: 'Ana',
      lastName: 'Silva',
      avatarUrl: null,
      reason: 'private note about the guest',
      createdAt: new Date('2026-10-29T20:00:00Z'),
    };
    eventBansServiceMock.ban.mockResolvedValue(barView);
    const dto: CreateEventBanDto = {
      memberSlug: 'ana-silva',
      reason: 'private note about the guest',
    };

    await expect(service.bar(STAFF_USER_ID, EVENT_SLUG, dto)).resolves.toBe(
      barView,
    );

    expect(eventBansServiceMock.ban).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      'ana-silva',
      'private note about the guest',
    );
    const rows = savedAuditRows();
    expect(rows).toEqual([
      {
        reportId: null,
        actorId: STAFF_USER_ID,
        action: 'music_event_guest_barred',
        targetUserId: 'member-1',
        targetName: 'Ana Silva',
        reasonCode: null,
        note: EVENT_SLUG,
        duration: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('private note');
    expect(banExists).toHaveBeenCalledWith({
      where: { eventId: 'event-1', userId: 'member-1' },
    });
  });

  it('writes no second guest_barred row when the member was already barred', async () => {
    banExists.mockResolvedValue(true);
    eventBansServiceMock.ban.mockResolvedValue({ slug: 'ana-silva' });

    await service.bar(STAFF_USER_ID, EVENT_SLUG, { memberSlug: 'ana-silva' });

    expect(eventBansServiceMock.ban).toHaveBeenCalledTimes(1);
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('writes no audit row when lifting a bar that never existed', async () => {
    banExists.mockResolvedValue(false);
    eventBansServiceMock.lift.mockResolvedValue({ ok: true });

    await expect(
      service.liftBar(STAFF_USER_ID, EVENT_SLUG, 'ana-silva'),
    ).resolves.toEqual({ ok: true });

    expect(eventBansServiceMock.lift).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      'ana-silva',
    );
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('names a member with both names blank by their profile slug', async () => {
    profileFindOne.mockResolvedValue(
      profileFixture({ firstName: '', lastName: ' ' }),
    );
    rsvpServiceMock.removeAttendee.mockResolvedValue({ ok: true });

    await service.removeGuest(STAFF_USER_ID, EVENT_SLUG, 'ana-silva');

    expect(
      savedAuditRows().map((row) => [row.targetUserId, row.targetName]),
    ).toEqual([['member-1', 'ana-silva']]);
  });

  it('audits the CSV export once and returns the body unchanged', async () => {
    const csvBody = 'name,pronouns\r\nAna Silva,she/her\r\n';
    eventsServiceMock.attendeesCsv.mockResolvedValue(csvBody);

    await expect(service.exportCsv(STAFF_USER_ID, EVENT_SLUG)).resolves.toBe(
      csvBody,
    );

    expect(eventsServiceMock.attendeesCsv).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
    );
    expect(savedAuditRows()).toEqual([
      {
        reportId: null,
        actorId: STAFF_USER_ID,
        action: 'music_event_guests_exported',
        targetUserId: null,
        targetName: EVENT_TITLE,
        reasonCode: null,
        note: EVENT_SLUG,
        duration: null,
      },
    ]);
  });

  it('audits sent invites with the created count', async () => {
    eventInvitesServiceMock.createInvites.mockResolvedValue({
      created: 3,
      alreadyInvited: ['ana-silva'],
    });
    const dto: InviteEventDto = { slugs: ['ana-silva', 'bea', 'cris', 'dani'] };

    await service.sendInvites(STAFF_USER_ID, EVENT_SLUG, dto);

    expect(eventInvitesServiceMock.createInvites).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      dto.slugs,
    );
    expect(
      savedAuditRows().map((row) => [row.action, row.targetUserId, row.note]),
    ).toEqual([['music_event_invites_sent', null, `${EVENT_SLUG}: 3 sent`]]);
  });

  it.each([
    ['promote', 'music_event_waitlist_promoted'],
    ['removeGuest', 'music_event_guest_removed'],
    ['liftBar', 'music_event_guest_bar_lifted'],
  ] as const)(
    '%s acts as the house and audits the member by name',
    async (methodName, action) => {
      // The lift is audited only when a bar stood.
      banExists.mockResolvedValue(true);
      rsvpServiceMock.promoteAttendee.mockResolvedValue({ ok: true });
      rsvpServiceMock.removeAttendee.mockResolvedValue({ ok: true });
      eventBansServiceMock.lift.mockResolvedValue({ ok: true });

      await expect(
        service[methodName](STAFF_USER_ID, EVENT_SLUG, 'ana-silva'),
      ).resolves.toEqual({ ok: true });

      expect(profileFindOne).toHaveBeenCalledWith({
        where: { slug: 'ana-silva' },
        select: { userId: true, slug: true, firstName: true, lastName: true },
      });
      expect(
        savedAuditRows().map((row) => [
          row.action,
          row.actorId,
          row.targetUserId,
          row.targetName,
        ]),
      ).toEqual([[action, STAFF_USER_ID, 'member-1', 'Ana Silva']]);
    },
  );

  it('never audits a check-in or an undo', async () => {
    const result = { ok: true };
    eventCheckInServiceMock.checkIn.mockResolvedValue(result);
    eventCheckInServiceMock.undoCheckIn.mockResolvedValue(result);
    const dto: CheckInDto = { memberSlug: 'ana-silva' };

    await service.checkIn(EVENT_SLUG, dto);
    await service.undoCheckIn(EVENT_SLUG, 'ana-silva');

    expect(eventCheckInServiceMock.checkIn).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      dto,
    );
    expect(eventCheckInServiceMock.undoCheckIn).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      'ana-silva',
    );
    expect(auditCreate).not.toHaveBeenCalled();
    expect(auditSave).not.toHaveBeenCalled();
  });

  describe('answers music_event_not_found before calling any event service', () => {
    const bannedMember: CreateEventBanDto = { memberSlug: 'ana-silva' };
    const invitees: InviteEventDto = { slugs: ['ana-silva'] };
    const checkInBody: CheckInDto = { memberSlug: 'ana-silva' };
    const cases: [
      string,
      (target: AdminMusicEventGuestsService) => Promise<unknown>,
    ][] = [
      ['roster', (target) => target.roster(EVENT_SLUG, {})],
      ['exportCsv', (target) => target.exportCsv(STAFF_USER_ID, EVENT_SLUG)],
      [
        'promote',
        (target) => target.promote(STAFF_USER_ID, EVENT_SLUG, 'ana-silva'),
      ],
      [
        'removeGuest',
        (target) => target.removeGuest(STAFF_USER_ID, EVENT_SLUG, 'ana-silva'),
      ],
      ['bar', (target) => target.bar(STAFF_USER_ID, EVENT_SLUG, bannedMember)],
      ['listBars', (target) => target.listBars(EVENT_SLUG)],
      [
        'liftBar',
        (target) => target.liftBar(STAFF_USER_ID, EVENT_SLUG, 'ana-silva'),
      ],
      [
        'sendInvites',
        (target) => target.sendInvites(STAFF_USER_ID, EVENT_SLUG, invitees),
      ],
      ['listInviteRequests', (target) => target.listInviteRequests(EVENT_SLUG)],
      [
        'decideInviteRequest',
        (target) =>
          target.decideInviteRequest(
            STAFF_USER_ID,
            EVENT_SLUG,
            INVITE_ID,
            'approve',
          ),
      ],
      ['checkIn', (target) => target.checkIn(EVENT_SLUG, checkInBody)],
      ['undoCheckIn', (target) => target.undoCheckIn(EVENT_SLUG, 'ana-silva')],
    ];

    it.each(cases)('%s', async (_methodName, callMethod) => {
      loadOrNotFound.mockRejectedValue(
        houseMusicEventError('music_event_not_found'),
      );

      await expectCode(callMethod(service), 404, 'music_event_not_found');

      for (const mock of memberServiceMocks) {
        expect(mock).not.toHaveBeenCalled();
      }
      expect(profileFindOne).not.toHaveBeenCalled();
      expect(auditSave).not.toHaveBeenCalled();
    });
  });
});
