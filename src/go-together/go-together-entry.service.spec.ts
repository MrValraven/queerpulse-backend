import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { Event, EventStatus } from '../events/entities/event.entity';
import { EventAudienceGateService } from '../events/event-audience-gate.service';
import { EventsService } from '../events/events.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { GoTogetherEligibilityService } from './go-together-eligibility.service';
import { GoTogetherEntryService } from './go-together-entry.service';
import { GoTogetherHostService } from './go-together-host.service';
import { GoTogetherProfileService } from './go-together-profile.service';

async function expectRejection(
  pending: Promise<unknown>,
  expectedClass: new (...args: never[]) => HttpException,
  body: Record<string, unknown>,
): Promise<HttpException> {
  const caught: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(expectedClass);
  expect((caught as HttpException).getResponse()).toMatchObject(body);
  return caught as HttpException;
}

/** True when every plain field in `where` equals the row's value. */
function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  const fields = row as Record<string, unknown>;
  return Object.entries(where).every(
    ([field, expected]) => fields[field] === expected,
  );
}

describe('GoTogetherEntryService', () => {
  const event = {
    id: 'event-1',
    slug: 'picnic',
    title: 'Picnic in the park',
    hostId: 'host-1',
    status: EventStatus.Published,
    startAt: new Date('2026-10-10T20:00:00Z'),
  } as Event;
  const config = {
    eventId: 'event-1',
    enabled: true,
    cutoffAt: new Date('2026-10-08T20:00:00Z'),
    hostQuestions: [
      {
        id: 'q1',
        prompt: 'Coffee or tea?',
        options: [
          { id: 'o1', label: 'Coffee' },
          { id: 'o2', label: 'Tea' },
        ],
      },
    ],
    meetingPointNote: null,
    matchedAt: null,
    lateGroupAt: null,
    feedbackPromptedAt: null,
    runCount: 0,
  } as EventMatchConfig;
  const friendProfile = {
    userId: 'friend',
    slug: 'friend-slug',
    firstName: 'Rita',
    lastName: 'Silva',
    pronouns: 'she/her',
    avatarUrl: null,
    photoVisible: true,
  } as Profile;

  let entryRows: Partial<EventMatchEntry>[];
  let service: GoTogetherEntryService;
  let entries: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let profiles: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let eligibility: { eventBlocker: jest.Mock; memberBlockers: jest.Mock };
  let host: { effectiveConfig: jest.Mock; ensureConfigRow: jest.Mock };
  let profileService: {
    findUsable: jest.Mock;
    touchUsed: jest.Mock;
    getMine: jest.Mock;
  };
  let connections: { areConnected: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    entryRows = [];
    entries = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          entryRows.find((row) => matchesWhere(row, where)) ?? null,
        ),
      ),
      create: jest.fn((row: Partial<EventMatchEntry>) => ({ ...row })),
      save: jest.fn((row: EventMatchEntry) => Promise.resolve(row)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    profiles = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          matchesWhere(friendProfile, where) ? friendProfile : null,
        ),
      ),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (manager: { getRepository: () => unknown }) => unknown) =>
          work({ getRepository: () => entries }),
      ),
    };
    eligibility = {
      eventBlocker: jest.fn().mockReturnValue(null),
      memberBlockers: jest.fn().mockResolvedValue(new Map()),
    };
    host = {
      effectiveConfig: jest.fn().mockResolvedValue(config),
      ensureConfigRow: jest.fn().mockResolvedValue(config),
    };
    profileService = {
      findUsable: jest.fn().mockResolvedValue({ userId: 'me' }),
      touchUsed: jest.fn().mockResolvedValue(undefined),
      getMine: jest
        .fn()
        .mockResolvedValue({ questionnaireVersion: 1, needsRefresh: false }),
    };
    connections = { areConnected: jest.fn().mockResolvedValue(true) };
    notifications = { create: jest.fn().mockResolvedValue(null) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherEntryService,
        {
          provide: getRepositoryToken(Event),
          useValue: { findOne: jest.fn().mockResolvedValue(event) },
        },
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        {
          provide: EventsService,
          useValue: { isOrganizer: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: EventAudienceGateService,
          useValue: { assertViewable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: GoTogetherEligibilityService, useValue: eligibility },
        { provide: GoTogetherHostService, useValue: host },
        { provide: GoTogetherProfileService, useValue: profileService },
        { provide: ConnectionsService, useValue: connections },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(GoTogetherEntryService);
  });

  it('creates a waiting solo entry with the parsed host answers and marks the profile used', async () => {
    const card = await service.optIn('picnic', 'me', {
      mode: 'solo',
      hostAnswers: { q1: 'o2', stray: 'ignored' },
    });
    expect(host.ensureConfigRow).toHaveBeenCalledWith(event);
    expect(entries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        userId: 'me',
        status: 'waiting',
        pairPartnerId: null,
        pairStatus: 'none',
        hostAnswers: { q1: 'o2' },
        lens: null,
        lensConsentedAt: null,
      }),
    );
    expect(profileService.touchUsed).toHaveBeenCalledWith('me');
    expect(notifications.create).not.toHaveBeenCalled();
    expect(card.optInClosesAt).toBe('2026-10-10T14:00:00.000Z');
  });

  it('asks for the questionnaire when the member has no usable profile', async () => {
    profileService.findUsable.mockResolvedValue(null);
    await expectRejection(
      service.optIn('picnic', 'me', {
        mode: 'solo',
        hostAnswers: { q1: 'o1' },
      }),
      ConflictException,
      { code: 'GO_TOGETHER_PROFILE_NEEDED' },
    );
    expect(entries.save).not.toHaveBeenCalled();
    expect(profileService.touchUsed).not.toHaveBeenCalled();
  });

  it('requires consent before storing a group focus', async () => {
    await expectRejection(
      service.optIn('picnic', 'me', {
        mode: 'solo',
        hostAnswers: { q1: 'o1' },
        lens: 'queerPoc',
      }),
      BadRequestException,
      { code: 'GO_TOGETHER_LENS_CONSENT_REQUIRED' },
    );
    expect(entries.save).not.toHaveBeenCalled();
  });

  it('refuses a pair invite to a member who is not a connection', async () => {
    connections.areConnected.mockResolvedValue(false);
    await expectRejection(
      service.optIn('picnic', 'me', {
        mode: 'pair',
        partnerSlug: 'friend-slug',
        hostAnswers: { q1: 'o1' },
      }),
      ConflictException,
      { code: 'GO_TOGETHER_PARTNER_UNAVAILABLE' },
    );
    expect(connections.areConnected).toHaveBeenCalledWith('me', 'friend');
    expect(entries.save).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('stores a pending pair and invites the friend with the inviter as actor', async () => {
    await service.optIn('picnic', 'me', {
      mode: 'pair',
      partnerSlug: 'friend-slug',
      hostAnswers: { q1: 'o1' },
    });
    expect(entries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        status: 'waiting',
        pairPartnerId: 'friend',
        pairStatus: 'pending',
      }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      'friend',
      NotificationType.GoTogetherPairInvite,
      expect.objectContaining({
        eventId: 'event-1',
        eventSlug: 'picnic',
        eventTitle: 'Picnic in the park',
        actorId: 'me',
      }),
      'me',
    );
  });

  it('refuses to accept an invite with a different group focus than the inviter', async () => {
    entryRows.push({
      id: 'entry-friend',
      eventId: 'event-1',
      userId: 'friend',
      pairPartnerId: 'me',
      pairStatus: 'pending',
      status: 'waiting',
      lens: 'queerPoc',
    });
    await expectRejection(
      service.acceptPair('picnic', 'me', { hostAnswers: { q1: 'o1' } }),
      ConflictException,
      { code: 'GO_TOGETHER_LENS_MISMATCH' },
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('accepts an invite by pointing both entries at each other', async () => {
    entryRows.push({
      id: 'entry-friend',
      eventId: 'event-1',
      userId: 'friend',
      pairPartnerId: 'me',
      pairStatus: 'pending',
      status: 'waiting',
      lens: null,
    });
    await service.acceptPair('picnic', 'me', { hostAnswers: { q1: 'o2' } });
    expect(dataSource.transaction).toHaveBeenCalled();
    expect(entries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        userId: 'me',
        status: 'waiting',
        pairPartnerId: 'friend',
        pairStatus: 'accepted',
        hostAnswers: { q1: 'o2' },
      }),
    );
    expect(entries.update).toHaveBeenCalledWith(
      { id: 'entry-friend', pairPartnerId: 'me', status: 'waiting' },
      { pairStatus: 'accepted' },
    );
    expect(profileService.touchUsed).toHaveBeenCalledWith('me');
  });

  it('keeps an accepted pair accepted on a re-opt-in with the same group focus', async () => {
    entryRows.push(
      {
        id: 'entry-me',
        eventId: 'event-1',
        userId: 'me',
        pairPartnerId: 'friend',
        pairStatus: 'accepted',
        status: 'waiting',
        lens: null,
      },
      {
        id: 'entry-friend',
        eventId: 'event-1',
        userId: 'friend',
        pairPartnerId: 'me',
        pairStatus: 'accepted',
        status: 'waiting',
        lens: null,
      },
    );
    await service.optIn('picnic', 'me', {
      mode: 'pair',
      partnerSlug: 'friend-slug',
      hostAnswers: { q1: 'o2' },
    });
    expect(entries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        pairPartnerId: 'friend',
        pairStatus: 'accepted',
        hostAnswers: { q1: 'o2' },
      }),
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('refuses a re-opt-in that would give an accepted pair two group focuses', async () => {
    entryRows.push(
      {
        id: 'entry-me',
        eventId: 'event-1',
        userId: 'me',
        pairPartnerId: 'friend',
        pairStatus: 'accepted',
        status: 'waiting',
        lens: null,
      },
      {
        id: 'entry-friend',
        eventId: 'event-1',
        userId: 'friend',
        pairPartnerId: 'me',
        pairStatus: 'accepted',
        status: 'waiting',
        lens: null,
      },
    );
    await expectRejection(
      service.optIn('picnic', 'me', {
        mode: 'pair',
        partnerSlug: 'friend-slug',
        hostAnswers: { q1: 'o1' },
        lens: 'queerPoc',
        lensConsent: true,
      }),
      ConflictException,
      { code: 'GO_TOGETHER_LENS_MISMATCH' },
    );
    expect(entries.save).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('treats a pair opt-in toward a friend who already invited the caller as accepting that invite', async () => {
    entryRows.push({
      id: 'entry-friend',
      eventId: 'event-1',
      userId: 'friend',
      pairPartnerId: 'me',
      pairStatus: 'pending',
      status: 'waiting',
      lens: null,
    });
    await service.optIn('picnic', 'me', {
      mode: 'pair',
      partnerSlug: 'friend-slug',
      hostAnswers: { q1: 'o1' },
    });
    expect(dataSource.transaction).toHaveBeenCalled();
    expect(entries.update).toHaveBeenCalledWith(
      { id: 'entry-friend', pairPartnerId: 'me', status: 'waiting' },
      { pairStatus: 'accepted' },
    );
    expect(entries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        status: 'waiting',
        pairPartnerId: 'friend',
        pairStatus: 'accepted',
      }),
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('refuses crossing invites with different group focuses', async () => {
    entryRows.push({
      id: 'entry-friend',
      eventId: 'event-1',
      userId: 'friend',
      pairPartnerId: 'me',
      pairStatus: 'pending',
      status: 'waiting',
      lens: 'womenFemmes',
    });
    await expectRejection(
      service.optIn('picnic', 'me', {
        mode: 'pair',
        partnerSlug: 'friend-slug',
        hostAnswers: { q1: 'o1' },
      }),
      ConflictException,
      { code: 'GO_TOGETHER_LENS_MISMATCH' },
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('sends a grouped member to Leave group', async () => {
    entryRows.push({
      id: 'entry-me',
      eventId: 'event-1',
      userId: 'me',
      status: 'grouped',
      pairStatus: 'none',
      pairPartnerId: null,
      groupId: 'group-1',
    });
    await expectRejection(service.withdraw('picnic', 'me'), ConflictException, {
      code: 'GO_TOGETHER_ALREADY_GROUPED',
    });
    expect(entries.save).not.toHaveBeenCalled();
  });

  it('withdraws a waiting accepted pair with its lens and puts the friend back to solo', async () => {
    entryRows.push({
      id: 'entry-me',
      eventId: 'event-1',
      userId: 'me',
      status: 'waiting',
      pairStatus: 'accepted',
      pairPartnerId: 'friend',
      lens: 'queerPoc',
      lensConsentedAt: new Date('2026-10-01T10:00:00Z'),
    });
    await service.withdraw('picnic', 'me');
    expect(entries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        status: 'withdrawn',
        pairStatus: 'none',
        pairPartnerId: null,
        lens: null,
        lensConsentedAt: null,
      }),
    );
    expect(entries.update).toHaveBeenCalledWith(
      { eventId: 'event-1', userId: 'friend', pairPartnerId: 'me' },
      { pairStatus: 'none', pairPartnerId: null },
    );
  });

  it('refuses an ineligible member with a 403 that names the reason', async () => {
    eligibility.memberBlockers.mockResolvedValue(
      new Map([['me', 'notVerified']]),
    );
    const error = await expectRejection(
      service.optIn('picnic', 'me', {
        mode: 'solo',
        hostAnswers: { q1: 'o1' },
      }),
      ForbiddenException,
      { code: 'GO_TOGETHER_INELIGIBLE', reason: 'notVerified' },
    );
    expect(error.getStatus()).toBe(403);
    expect(entries.save).not.toHaveBeenCalled();
  });

  it('shows the matching time that applies after the gathering moved', async () => {
    host.effectiveConfig.mockResolvedValue({
      ...config,
      // Saved for an earlier date; the gathering now starts 2026-10-10 20:00.
      cutoffAt: new Date('2026-09-20T20:00:00Z'),
    });
    const movedCard = await service.card('picnic', 'me');
    expect(movedCard.cutoffAt).toBe('2026-10-03T20:00:00.000Z');

    host.effectiveConfig.mockResolvedValue(config);
    const unchangedCard = await service.card('picnic', 'me');
    expect(unchangedCard.cutoffAt).toBe('2026-10-08T20:00:00.000Z');
  });

  it('shows an incoming invite on the card with the friend as partner', async () => {
    entryRows.push({
      id: 'entry-friend',
      eventId: 'event-1',
      userId: 'friend',
      pairPartnerId: 'me',
      pairStatus: 'pending',
      status: 'waiting',
      lens: null,
    });
    const card = await service.card('picnic', 'me');
    expect(card.state).toBe('pairInvite');
    expect(card.pair).toEqual({
      partner: {
        slug: 'friend-slug',
        firstName: 'Rita',
        lastName: 'Silva',
        pronouns: 'she/her',
        avatarUrl: null,
      },
      status: 'pending',
      direction: 'received',
    });
    expect(card.profile).toEqual({ exists: true, needsRefresh: false });
  });
});
