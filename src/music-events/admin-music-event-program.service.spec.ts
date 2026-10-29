import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { Event } from '../events/entities/event.entity';
import { EventAnnouncementsService } from '../events/event-announcements.service';
import {
  EventLineupService,
  type LineupEligibilityCheck,
} from '../events/event-lineup.service';
import { EventsService } from '../events/events.service';
import { GatheringFamily } from '../events/gathering-family';
import { houseMusicEventError } from '../events/house-music-event-errors';
import { HostConfigDto } from '../go-together/dto/host-config.dto';
import { GoTogetherHostService } from '../go-together/go-together-host.service';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { AdminMusicEventProgramService } from './admin-music-event-program.service';
import { HouseMusicEventScopeService } from './house-music-event-scope.service';
import { MUSIC_EVENT_AUDIT_ACTIONS } from './music-event-audit';
import { StudioArtistSearchService } from './studio-artist-search.service';

const HOUSE_USER_ID = 'house-user-1';
const STAFF_USER_ID = 'staff-user-1';
const MEMBER_USER_ID = 'member-user-1';
const SECOND_MEMBER_USER_ID = 'member-user-2';
const EVENT_SLUG = 'friday-set';

function eventFixture(): Event {
  const fixture: Partial<Event> = {
    id: 'event-1',
    slug: EVENT_SLUG,
    title: 'Friday Set',
    hostId: HOUSE_USER_ID,
    gatheringFamily: GatheringFamily.Music,
  };
  return fixture as Event;
}

function profileFixture(overrides: Partial<Profile>): Profile {
  const fixture: Partial<Profile> = {
    userId: MEMBER_USER_ID,
    slug: 'ana-silva',
    firstName: 'Ana',
    lastName: 'Silva',
    avatarUrl: null,
    photoVisible: true,
    ...overrides,
  };
  return fixture as Profile;
}

function userFixture(overrides: Partial<User>): User {
  const fixture: Partial<User> = {
    id: MEMBER_USER_ID,
    status: UserStatus.Active,
    ...overrides,
  };
  return fixture as User;
}

function cohostFixture(overrides: Partial<EventCohost>): EventCohost {
  const fixture: Partial<EventCohost> = {
    id: 'seat-1',
    eventId: 'event-1',
    userId: MEMBER_USER_ID,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
  return fixture as EventCohost;
}

async function expectReasonCode(
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

function auditRepositoryMock() {
  return {
    create: jest.fn((row: Partial<ModAuditLog>) => row),
    save: jest.fn((row: Partial<ModAuditLog>) => Promise.resolve(row)),
  };
}

describe('AdminMusicEventProgramService', () => {
  let service: AdminMusicEventProgramService;

  const loadOrNotFound = jest.fn();
  const inviteWithEligibilityCheck = jest.fn();
  const getLineup = jest.fn();
  const changeRole = jest.fn();
  const removeFromLineup = jest.fn();
  const assertBookable = jest.fn();
  const listAnnouncements = jest.fn();
  const createAnnouncement = jest.fn();
  const addCohostByUserId = jest.fn();
  const removeCohost = jest.fn();
  const getConfig = jest.fn();
  const putConfig = jest.fn();
  const summary = jest.fn();
  const cohostFind = jest.fn();
  const cohostExists = jest.fn();
  const profileFindOne = jest.fn();
  const profileFind = jest.fn();
  const auditLogRepository = auditRepositoryMock();

  const transactionAuditRepository = auditRepositoryMock();
  const userFindOne = jest.fn();
  const transactionCohostExists = jest.fn();
  let seatRefusal: string | null = null;
  const managerQuery = jest.fn((sql: string) =>
    Promise.resolve(
      sql.includes('pg_advisory_xact_lock') ? [] : [{ refusal: seatRefusal }],
    ),
  );
  const transactionManager = {
    query: managerQuery,
    getRepository: jest.fn((entity: unknown) => {
      if (entity === User) return { findOne: userFindOne };
      if (entity === EventCohost) return { exists: transactionCohostExists };
      return transactionAuditRepository;
    }),
  };
  const transaction = jest.fn(
    (work: (manager: typeof transactionManager) => Promise<unknown>) =>
      work(transactionManager),
  );

  const everyEventServiceMock = [
    inviteWithEligibilityCheck,
    getLineup,
    changeRole,
    removeFromLineup,
    assertBookable,
    listAnnouncements,
    createAnnouncement,
    addCohostByUserId,
    removeCohost,
    getConfig,
    putConfig,
    summary,
    cohostFind,
    cohostExists,
    profileFindOne,
    profileFind,
    transaction,
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    seatRefusal = null;
    loadOrNotFound.mockResolvedValue({
      event: eventFixture(),
      houseUserId: HOUSE_USER_ID,
    });
    profileFindOne.mockResolvedValue(profileFixture({}));
    userFindOne.mockResolvedValue(userFixture({}));
    transactionCohostExists.mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminMusicEventProgramService,
        { provide: getDataSourceToken(), useValue: { transaction } },
        {
          provide: getRepositoryToken(EventCohost),
          useValue: { find: cohostFind, exists: cohostExists },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: { findOne: profileFindOne, find: profileFind },
        },
        {
          provide: getRepositoryToken(ModAuditLog),
          useValue: auditLogRepository,
        },
        { provide: HouseMusicEventScopeService, useValue: { loadOrNotFound } },
        {
          provide: EventLineupService,
          useValue: {
            getLineup,
            inviteWithEligibilityCheck,
            changeRole,
            remove: removeFromLineup,
          },
        },
        { provide: StudioArtistSearchService, useValue: { assertBookable } },
        {
          provide: EventAnnouncementsService,
          useValue: { list: listAnnouncements, create: createAnnouncement },
        },
        {
          provide: EventsService,
          useValue: { addCohostByUserId, removeCohost },
        },
        {
          provide: GoTogetherHostService,
          useValue: { getConfig, putConfig, summary },
        },
      ],
    }).compile();
    service = moduleRef.get(AdminMusicEventProgramService);
  });

  it('books through inviteWithEligibilityCheck with the house as inviter and the staff member in the check', async () => {
    const lineup = { entries: [], viewerEntry: null };
    inviteWithEligibilityCheck.mockResolvedValue(lineup);
    assertBookable.mockResolvedValue(undefined);
    const dto = { memberSlug: 'ana-silva', role: 'DJ' };

    await expect(service.book(STAFF_USER_ID, EVENT_SLUG, dto)).resolves.toBe(
      lineup,
    );

    expect(inviteWithEligibilityCheck).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      dto,
      expect.any(Function),
    );
    const eligibilityCheck = inviteWithEligibilityCheck.mock
      .calls[0]?.[3] as LineupEligibilityCheck;
    await eligibilityCheck('event-1', MEMBER_USER_ID);
    expect(assertBookable).toHaveBeenCalledWith(STAFF_USER_ID, MEMBER_USER_ID);
    expect(auditLogRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: STAFF_USER_ID,
        action: MUSIC_EVENT_AUDIT_ACTIONS.lineupChanged,
        targetUserId: MEMBER_USER_ID,
        targetName: 'Ana Silva',
        note: `${EVENT_SLUG}: booked as DJ`,
      }),
    );
  });

  it('refuses the acting holder with music_event_cohost_is_you before opening a transaction', async () => {
    profileFindOne.mockResolvedValue(profileFixture({ userId: STAFF_USER_ID }));

    await expectReasonCode(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' }),
      403,
      'music_event_cohost_is_you',
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(addCohostByUserId).not.toHaveBeenCalled();
  });

  it('refuses a holder, a moderator and an inactive member with their own codes', async () => {
    seatRefusal = 'music_event_cohost_holds_grant';
    await expectReasonCode(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' }),
      403,
      'music_event_cohost_holds_grant',
    );

    seatRefusal = 'music_event_cohost_is_staff_tier';
    await expectReasonCode(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' }),
      403,
      'music_event_cohost_is_staff_tier',
    );

    seatRefusal = null;
    userFindOne.mockResolvedValue(
      userFixture({ status: UserStatus.Suspended }),
    );
    await expectReasonCode(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' }),
      400,
      'music_event_cohost_not_active',
    );

    profileFindOne.mockResolvedValue(null);
    await expectReasonCode(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'nobody' }),
      404,
      'music_event_member_not_found',
    );

    expect(addCohostByUserId).not.toHaveBeenCalled();
    expect(transactionAuditRepository.save).not.toHaveBeenCalled();
  });

  it('writes the co-host audit row on the transaction manager', async () => {
    addCohostByUserId.mockResolvedValue(undefined);

    await expect(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' }),
    ).resolves.toEqual({ ok: true });

    const lockCallIndex = managerQuery.mock.calls.findIndex(([sql]) =>
      sql.includes('pg_advisory_xact_lock'),
    );
    expect(lockCallIndex).toBe(0);
    expect(addCohostByUserId).toHaveBeenCalledWith(
      'event-1',
      MEMBER_USER_ID,
      transactionManager,
    );
    expect(transactionAuditRepository.save).toHaveBeenCalledWith({
      reportId: null,
      actorId: STAFF_USER_ID,
      action: MUSIC_EVENT_AUDIT_ACTIONS.cohostAdded,
      targetUserId: MEMBER_USER_ID,
      targetName: 'Ana Silva',
      reasonCode: null,
      note: EVENT_SLUG,
      duration: null,
    });
    expect(auditLogRepository.save).not.toHaveBeenCalled();
    expect(transactionCohostExists).toHaveBeenCalledWith({
      where: { eventId: 'event-1', userId: MEMBER_USER_ID },
    });
  });

  it('names a co-host with both names blank by their profile slug', async () => {
    profileFindOne.mockResolvedValue(
      profileFixture({ firstName: '', lastName: ' ' }),
    );
    addCohostByUserId.mockResolvedValue(undefined);

    await service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' });

    expect(transactionAuditRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: MEMBER_USER_ID,
        targetName: 'ana-silva',
      }),
    );
  });

  it('writes no cohostAdded row when the member already held the seat', async () => {
    transactionCohostExists.mockResolvedValue(true);
    addCohostByUserId.mockResolvedValue(undefined);

    await expect(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' }),
    ).resolves.toEqual({ ok: true });

    expect(addCohostByUserId).toHaveBeenCalledTimes(1);
    expect(transactionAuditRepository.save).not.toHaveBeenCalled();
    expect(auditLogRepository.save).not.toHaveBeenCalled();
  });

  it('writes no cohostAdded row when the house account is named as co-host', async () => {
    profileFindOne.mockResolvedValue(profileFixture({ userId: HOUSE_USER_ID }));
    userFindOne.mockResolvedValue(userFixture({ id: HOUSE_USER_ID }));
    addCohostByUserId.mockResolvedValue(undefined);

    await expect(
      service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'queerpulse' }),
    ).resolves.toEqual({ ok: true });

    expect(transactionCohostExists).not.toHaveBeenCalled();
    expect(transactionAuditRepository.save).not.toHaveBeenCalled();
    expect(auditLogRepository.save).not.toHaveBeenCalled();
  });

  it('lists co-hosts through toOrganizerView in seat order', async () => {
    cohostFind.mockResolvedValue([
      cohostFixture({ id: 'seat-1', userId: SECOND_MEMBER_USER_ID }),
      cohostFixture({ id: 'seat-2', userId: MEMBER_USER_ID }),
    ]);
    profileFind.mockResolvedValue([
      profileFixture({}),
      profileFixture({
        userId: SECOND_MEMBER_USER_ID,
        slug: 'bia-costa',
        firstName: 'Bia',
        lastName: 'Costa',
      }),
    ]);

    await expect(service.cohosts(EVENT_SLUG)).resolves.toEqual([
      {
        slug: 'bia-costa',
        firstName: 'Bia',
        lastName: 'Costa',
        avatarUrl: null,
      },
      {
        slug: 'ana-silva',
        firstName: 'Ana',
        lastName: 'Silva',
        avatarUrl: null,
      },
    ]);
    expect(cohostFind).toHaveBeenCalledWith({
      where: { eventId: 'event-1' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  });

  it('keeps the announcement body out of the audit row', async () => {
    const body = 'We moved to the back stage, the code is 4471';
    createAnnouncement.mockResolvedValue({ id: 'announcement-1', body });

    await service.postAnnouncement(STAFF_USER_ID, EVENT_SLUG, { body });

    expect(createAnnouncement).toHaveBeenCalledWith(
      EVENT_SLUG,
      HOUSE_USER_ID,
      body,
    );
    const savedRow = auditLogRepository.save.mock.calls[0]?.[0];
    expect(savedRow).toEqual(
      expect.objectContaining({
        action: MUSIC_EVENT_AUDIT_ACTIONS.announcementPosted,
        targetName: 'Friday Set',
        note: EVENT_SLUG,
      }),
    );
    expect(JSON.stringify(savedRow)).not.toContain('4471');
  });

  it('saves Go Together as the house and audits the switch', async () => {
    const dto: HostConfigDto = { enabled: false, hostQuestions: [] };
    const config = { enabled: false };
    putConfig.mockResolvedValue(config);

    await expect(
      service.saveGoTogetherConfig(STAFF_USER_ID, EVENT_SLUG, dto),
    ).resolves.toBe(config);

    expect(putConfig).toHaveBeenCalledWith(EVENT_SLUG, HOUSE_USER_ID, dto);
    expect(auditLogRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: STAFF_USER_ID,
        action: MUSIC_EVENT_AUDIT_ACTIONS.goTogetherChanged,
        targetUserId: null,
        targetName: 'Friday Set',
        note: `${EVENT_SLUG}: enabled false`,
      }),
    );
  });

  it('answers music_event_not_found before calling any event service', async () => {
    loadOrNotFound.mockRejectedValue(
      houseMusicEventError('music_event_not_found'),
    );
    const callEveryMethod: (() => Promise<unknown>)[] = [
      () => service.lineup(EVENT_SLUG),
      () =>
        service.book(STAFF_USER_ID, EVENT_SLUG, {
          memberSlug: 'ana-silva',
          role: 'DJ',
        }),
      () =>
        service.changeRole(STAFF_USER_ID, EVENT_SLUG, 'ana-silva', {
          role: 'MC',
        }),
      () => service.removePerformer(STAFF_USER_ID, EVENT_SLUG, 'ana-silva'),
      () => service.announcements(EVENT_SLUG),
      () =>
        service.postAnnouncement(STAFF_USER_ID, EVENT_SLUG, { body: 'Hello' }),
      () => service.cohosts(EVENT_SLUG),
      () => service.addCohost(STAFF_USER_ID, EVENT_SLUG, { slug: 'ana-silva' }),
      () => service.removeCohost(STAFF_USER_ID, EVENT_SLUG, 'ana-silva'),
      () => service.goTogetherConfig(EVENT_SLUG),
      () =>
        service.saveGoTogetherConfig(STAFF_USER_ID, EVENT_SLUG, {
          enabled: true,
          hostQuestions: [],
        }),
      () => service.goTogetherSummary(EVENT_SLUG),
    ];

    for (const callMethod of callEveryMethod) {
      await expectReasonCode(callMethod(), 404, 'music_event_not_found');
    }
    for (const eventServiceMock of everyEventServiceMock) {
      expect(eventServiceMock).not.toHaveBeenCalled();
    }
    expect(auditLogRepository.save).not.toHaveBeenCalled();
  });
});
