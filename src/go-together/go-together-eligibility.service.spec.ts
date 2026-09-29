import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventBan } from '../events/entities/event-ban.entity';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { EventMatchConfig } from './entities/event-match-config.entity';
import {
  GoTogetherEligibilityService,
  effectiveCutoffAt,
  optInClosesAt,
} from './go-together-eligibility.service';

describe('GoTogetherEligibilityService', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  let service: GoTogetherEligibilityService;
  const rsvps = { find: jest.fn() };
  const bans = { find: jest.fn() };
  const users = { find: jest.fn() };
  const profiles = { find: jest.fn() };
  const verification = { levelsForUsers: jest.fn() };

  beforeEach(async () => {
    rsvps.find.mockResolvedValue([
      { userId: 'going', status: RsvpStatus.Going, removedByHostAt: null },
      { userId: 'phone', status: RsvpStatus.Going, removedByHostAt: null },
      { userId: 'maybe', status: RsvpStatus.Maybe, removedByHostAt: null },
      {
        userId: 'removed',
        status: RsvpStatus.Going,
        removedByHostAt: new Date(),
      },
      { userId: 'banned', status: RsvpStatus.Going, removedByHostAt: null },
      { userId: 'restricted', status: RsvpStatus.Going, removedByHostAt: null },
      { userId: 'expired', status: RsvpStatus.Going, removedByHostAt: null },
      { userId: 'unverified', status: RsvpStatus.Going, removedByHostAt: null },
    ]);
    bans.find.mockResolvedValue([{ userId: 'banned' }]);
    const active = (userId: string, extra: Partial<User> = {}) => ({
      id: userId,
      status: UserStatus.Active,
      restricted: false,
      restrictedUntil: null,
      ...extra,
    });
    users.find.mockResolvedValue([
      active('going'),
      active('phone'),
      active('maybe'),
      active('removed'),
      active('banned'),
      active('restricted', { restricted: true, restrictedUntil: null }),
      active('expired', {
        restricted: true,
        restrictedUntil: new Date('2026-09-01T00:00:00Z'),
      }),
      active('unverified'),
      {
        id: 'suspended',
        status: UserStatus.Suspended,
        restricted: false,
        restrictedUntil: null,
      },
    ]);
    profiles.find.mockResolvedValue([
      { userId: 'going', verified: true },
      { userId: 'phone', verified: false },
      { userId: 'maybe', verified: true },
      { userId: 'removed', verified: true },
      { userId: 'banned', verified: true },
      { userId: 'restricted', verified: true },
      { userId: 'expired', verified: true },
      { userId: 'unverified', verified: false },
      { userId: 'suspended', verified: true },
    ]);
    verification.levelsForUsers.mockResolvedValue(
      new Map([
        ['phone', VerificationLevel.Phone],
        ['unverified', VerificationLevel.Email],
      ]),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherEligibilityService,
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(EventBan), useValue: bans },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: VerificationService, useValue: verification },
      ],
    }).compile();
    service = moduleRef.get(GoTogetherEligibilityService);
  });

  it('gives each member the first reason that applies, and none to eligible members', async () => {
    const userIds = [
      'going',
      'phone',
      'maybe',
      'removed',
      'banned',
      'restricted',
      'expired',
      'unverified',
      'suspended',
    ];
    const blockers = await service.memberBlockers('event-1', userIds, now);
    expect(blockers.get('going')).toBeUndefined();
    expect(blockers.get('phone')).toBeUndefined();
    expect(blockers.get('expired')).toBeUndefined();
    expect(blockers.get('maybe')).toBe('notGoing');
    expect(blockers.get('removed')).toBe('notGoing');
    expect(blockers.get('banned')).toBe('bannedFromEvent');
    expect(blockers.get('restricted')).toBe('restricted');
    expect(blockers.get('unverified')).toBe('notVerified');
    expect(blockers.get('suspended')).toBe('inactive');
  });

  it('closes opt-in six hours before the start and needs a published, enabled gathering', () => {
    const startAt = new Date('2026-10-01T17:00:00Z');
    const event = { status: EventStatus.Published, startAt } as Event;
    const config = { enabled: true } as EventMatchConfig;
    expect(optInClosesAt(event).toISOString()).toBe('2026-10-01T11:00:00.000Z');
    expect(service.eventBlocker(event, config, now)).toBe('closed');
    expect(
      service.eventBlocker(
        { ...event, startAt: new Date('2026-10-03T00:00:00Z') },
        config,
        now,
      ),
    ).toBeNull();
    expect(service.eventBlocker(event, null, now)).toBe('notEnabled');
    expect(
      service.eventBlocker(
        { ...event, status: EventStatus.Cancelled },
        config,
        now,
      ),
    ).toBe('eventNotPublished');
  });

  it('clamps a saved cutoff into 7 days to 6 hours before the current start', () => {
    const startAt = new Date('2026-10-20T20:00:00Z');
    // Inside the range: unchanged.
    expect(
      effectiveCutoffAt(
        new Date('2026-10-18T20:00:00Z'),
        startAt,
      ).toISOString(),
    ).toBe('2026-10-18T20:00:00.000Z');
    // The gathering moved later: the saved time is too early.
    expect(
      effectiveCutoffAt(
        new Date('2026-10-01T20:00:00Z'),
        startAt,
      ).toISOString(),
    ).toBe('2026-10-13T20:00:00.000Z');
    // The gathering moved earlier: the saved time is too late.
    expect(
      effectiveCutoffAt(
        new Date('2026-10-20T18:00:00Z'),
        startAt,
      ).toISOString(),
    ).toBe('2026-10-20T14:00:00.000Z');
  });
});
