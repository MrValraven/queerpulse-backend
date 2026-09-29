import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { Profile } from '../users/entities/profile.entity';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { MatchFeedback } from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import { GoTogetherFormationService } from './go-together-formation.service';
import { GoTogetherGroupService } from './go-together-group.service';

/** Equality plus the `In`, `Not` and `IsNull` operators the service uses. */
function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof FindOperator) {
    const operator = expected as FindOperator<unknown>;
    if (operator.type === 'in') {
      return (operator.value as unknown[]).includes(actual);
    }
    if (operator.type === 'not') return !matchesValue(actual, operator.value);
    if (operator.type === 'isNull') return actual === null;
    throw new Error(`Unsupported operator ${operator.type}`);
  }
  return actual === expected;
}

function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) =>
    matchesValue((row as Record<string, unknown>)[key], expected),
  );
}

async function expectRejection(
  pending: Promise<unknown>,
  expectedClass: new (...args: never[]) => HttpException,
  body?: Record<string, unknown>,
): Promise<void> {
  const caught: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(expectedClass);
  if (body) {
    expect((caught as HttpException).getResponse()).toMatchObject(body);
  }
}

function makeEntry(fields: Partial<EventMatchEntry>): EventMatchEntry {
  return {
    eventId: 'event-1',
    pairPartnerId: null,
    pairStatus: 'none',
    status: 'grouped',
    groupId: 'group-1',
    mergeOfferGroupId: null,
    checkedInAt: null,
    leftEventAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...fields,
  } as EventMatchEntry;
}

function makeProfile(fields: Partial<Profile>): Profile {
  return {
    lastName: 'Surname',
    bio: 'Private bio',
    photoVisible: true,
    avatarUrl: 'https://images.example.com/face.jpg',
    pronouns: null,
    ...fields,
  } as Profile;
}

describe('GoTogetherGroupService', () => {
  const startAt = new Date('2026-10-10T20:00:00Z');
  const endAt = new Date('2026-10-10T23:00:00Z');
  const event = {
    id: 'event-1',
    slug: 'picnic',
    title: 'Picnic in the park',
    startAt,
    endAt,
  } as Event;
  const firstGroup: EventMatchGroup = {
    id: 'group-1',
    eventId: 'event-1',
    conversationId: 'conversation-1',
    band: 'strong',
    reasons: [{ kind: 'energy', level: 'calm' }],
    scoringVersion: 1,
    solverSeedLabel: 'event-1:1',
    pairComponents: null,
    formedAt: new Date('2026-10-08T20:00:00Z'),
    dissolvedAt: null,
    trainingWrittenAt: null,
  };
  const secondGroup: EventMatchGroup = {
    ...firstGroup,
    id: 'group-2',
    conversationId: 'conversation-2',
    band: 'good',
    reasons: [],
  };

  let entryRows: EventMatchEntry[];
  let profileRows: Profile[];
  let service: GoTogetherGroupService;
  let entries: { findOne: jest.Mock; find: jest.Mock; update: jest.Mock };
  let groups: { findOne: jest.Mock };
  let configs: { findOne: jest.Mock };
  let events: { findOne: jest.Mock };
  let profiles: { find: jest.Mock };
  let feedback: { exists: jest.Mock };
  let groupFeedback: { exists: jest.Mock };
  let blockFilter: { blockedUserIds: jest.Mock };
  let formation: { removeMember: jest.Mock; acceptMerge: jest.Mock };

  beforeEach(async () => {
    entryRows = [
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
      makeEntry({ id: 'entry-3', userId: 'user-3' }),
      makeEntry({ id: 'entry-5', userId: 'user-5', status: 'withdrawn' }),
    ];
    profileRows = [
      makeProfile({
        userId: 'user-1',
        slug: 'ana',
        firstName: 'Ana',
        pronouns: 'she/her',
      }),
      makeProfile({ userId: 'user-2', slug: 'bea', firstName: 'Bea' }),
      makeProfile({
        userId: 'user-3',
        slug: 'cris',
        firstName: 'Cris',
        pronouns: 'they/them',
        photoVisible: false,
      }),
      makeProfile({ userId: 'user-5', slug: 'eli', firstName: 'Eli' }),
    ];
    entries = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          entryRows.find((row) => matchesWhere(row, where)) ?? null,
        ),
      ),
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(entryRows.filter((row) => matchesWhere(row, where))),
      ),
      update: jest.fn(
        (where: Record<string, unknown>, patch: Partial<EventMatchEntry>) => {
          for (const row of entryRows.filter((candidate) =>
            matchesWhere(candidate, where),
          )) {
            Object.assign(row, patch);
          }
          return Promise.resolve({ affected: 1 });
        },
      ),
    };
    groups = {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          [firstGroup, secondGroup].find((group) => group.id === where.id) ??
            null,
        ),
      ),
    };
    configs = {
      findOne: jest.fn().mockResolvedValue({
        eventId: 'event-1',
        meetingPointNote: 'By the fountain',
        feedbackPromptedAt: null,
      }),
    };
    events = { findOne: jest.fn().mockResolvedValue(event) };
    profiles = {
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(profileRows.filter((row) => matchesWhere(row, where))),
      ),
    };
    feedback = { exists: jest.fn().mockResolvedValue(false) };
    groupFeedback = { exists: jest.fn().mockResolvedValue(false) };
    blockFilter = {
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    formation = {
      removeMember: jest.fn().mockResolvedValue(undefined),
      acceptMerge: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherGroupService,
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
        { provide: getRepositoryToken(EventMatchGroup), useValue: groups },
        { provide: getRepositoryToken(EventMatchConfig), useValue: configs },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(MatchFeedback), useValue: feedback },
        {
          provide: getRepositoryToken(MatchGroupFeedback),
          useValue: groupFeedback,
        },
        { provide: GoTogetherFormationService, useValue: formation },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = moduleRef.get(GoTogetherGroupService);
  });

  describe('getGroup', () => {
    it('returns 404 to a member who is not grouped in that group, a former member included', async () => {
      await expectRejection(
        service.getGroup('group-1', 'user-5'),
        NotFoundException,
      );
      await expectRejection(
        service.getGroup('group-1', 'user-9'),
        NotFoundException,
      );
      expect(groups.findOne).not.toHaveBeenCalled();
    });

    it('shows first names and pronouns only, hides a hidden photo, and marks you and your partner', async () => {
      const card = await service.getGroup(
        'group-1',
        'user-1',
        new Date('2026-10-01T12:00:00Z'),
      );

      expect(card.members).toEqual([
        {
          slug: 'ana',
          firstName: 'Ana',
          pronouns: 'she/her',
          avatarUrl: 'https://images.example.com/face.jpg',
          isYou: true,
          isPairPartner: false,
          isHere: false,
          hasLeftEvent: false,
        },
        {
          slug: 'bea',
          firstName: 'Bea',
          pronouns: null,
          avatarUrl: 'https://images.example.com/face.jpg',
          isYou: false,
          isPairPartner: true,
          isHere: false,
          hasLeftEvent: false,
        },
        {
          slug: 'cris',
          firstName: 'Cris',
          pronouns: 'they/them',
          avatarUrl: null,
          isYou: false,
          isPairPartner: false,
          isHere: false,
          hasLeftEvent: false,
        },
      ]);
      expect(JSON.stringify(card)).not.toContain('Surname');
      expect(JSON.stringify(card)).not.toContain('Private bio');
      expect(card).toMatchObject({
        id: 'group-1',
        event: {
          id: 'event-1',
          slug: 'picnic',
          title: 'Picnic in the park',
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
        },
        band: 'strong',
        meetingPointNote: 'By the fountain',
        conversationId: 'conversation-1',
        isDissolved: false,
        mergeOffer: null,
        checkIn: { isOpen: false, isHere: false, hasLeftEvent: false },
        feedback: { isOpen: false, closesAt: null, hasAnswered: false },
      });
    });

    it('opens feedback for seven days from the prompt and reports an answer', async () => {
      const promptedAt = new Date('2026-10-11T12:00:00Z');
      configs.findOne.mockResolvedValue({
        eventId: 'event-1',
        meetingPointNote: null,
        feedbackPromptedAt: promptedAt,
      });
      feedback.exists.mockResolvedValue(true);

      const card = await service.getGroup(
        'group-1',
        'user-1',
        new Date('2026-10-12T12:00:00Z'),
      );

      expect(card.feedback).toEqual({
        isOpen: true,
        closesAt: new Date('2026-10-18T12:00:00Z').toISOString(),
        hasAnswered: true,
      });
      expect(feedback.exists).toHaveBeenCalledWith({
        where: { groupId: 'group-1', raterId: 'user-1' },
      });
    });

    it('counts an answer about the group alone as answered', async () => {
      groupFeedback.exists.mockResolvedValue(true);

      const card = await service.getGroup(
        'group-1',
        'user-1',
        new Date('2026-10-12T12:00:00Z'),
      );

      expect(card.feedback.hasAnswered).toBe(true);
      expect(groupFeedback.exists).toHaveBeenCalledWith({
        where: { groupId: 'group-1', raterId: 'user-1' },
      });
    });

    it('leaves out a member blocked either way with the caller', async () => {
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['user-3']));

      const card = await service.getGroup(
        'group-1',
        'user-1',
        new Date('2026-10-11T12:00:00Z'),
      );

      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('user-1', [
        'user-1',
        'user-2',
        'user-3',
      ]);
      expect(card.members.map((member) => member.slug)).toEqual(['ana', 'bea']);
    });
  });

  describe('checkIn', () => {
    it.each<{ label: string; eventEndAt: Date | null; nowIso: string }>([
      {
        label: 'before the window opens',
        eventEndAt: endAt,
        nowIso: '2026-10-10T16:59:59Z',
      },
      {
        label: 'after the window closes',
        eventEndAt: endAt,
        nowIso: '2026-10-11T05:00:01Z',
      },
      {
        label: 'after an open-ended gathering plus twelve hours',
        eventEndAt: null,
        nowIso: '2026-10-11T08:00:01Z',
      },
    ])('refuses a check-in $label', async ({ eventEndAt, nowIso }) => {
      events.findOne.mockResolvedValue({ ...event, endAt: eventEndAt });

      await expectRejection(
        service.checkIn('group-1', 'user-1', 'here', new Date(nowIso)),
        ConflictException,
        { code: 'GO_TOGETHER_CHECKIN_CLOSED' },
      );
      expect(entries.update).not.toHaveBeenCalled();
    });

    it('stamps checkedInAt for here and leftEventAt for left inside the window', async () => {
      const arrivedAt = new Date('2026-10-10T17:00:00Z');
      const hereCard = await service.checkIn(
        'group-1',
        'user-1',
        'here',
        arrivedAt,
      );

      expect(entries.update).toHaveBeenCalledWith(
        { id: 'entry-1' },
        { checkedInAt: arrivedAt, leftEventAt: null },
      );
      expect(hereCard.checkIn).toEqual({
        isOpen: true,
        isHere: true,
        hasLeftEvent: false,
      });

      const leftAt = new Date('2026-10-11T05:00:00Z');
      const leftCard = await service.checkIn(
        'group-1',
        'user-1',
        'left',
        leftAt,
      );

      expect(entries.update).toHaveBeenLastCalledWith(
        { id: 'entry-1' },
        { leftEventAt: leftAt },
      );
      expect(entryRows[0]).toMatchObject({
        checkedInAt: arrivedAt,
        leftEventAt: leftAt,
      });
      expect(leftCard.checkIn).toEqual({
        isOpen: true,
        isHere: false,
        hasLeftEvent: true,
      });
      expect(leftCard.members[0]).toMatchObject({
        isYou: true,
        hasLeftEvent: true,
      });
    });
  });

  describe('leave', () => {
    it("hands the caller's grouped entry to formation.removeMember", async () => {
      await service.leave('group-1', 'user-3');

      expect(formation.removeMember).toHaveBeenCalledTimes(1);
      expect(formation.removeMember).toHaveBeenCalledWith(entryRows[2]);
    });

    it('returns 404 and removes nobody when the caller is not grouped there', async () => {
      await expectRejection(
        service.leave('group-1', 'user-5'),
        NotFoundException,
      );
      expect(formation.removeMember).not.toHaveBeenCalled();
    });
  });

  describe('acceptMerge', () => {
    it('delegates to formation.acceptMerge and returns the new group', async () => {
      const crisEntry = entryRows.find((row) => row.userId === 'user-3');
      if (!crisEntry) throw new Error('Fixture is missing user-3');
      crisEntry.mergeOfferGroupId = 'group-2';
      formation.acceptMerge.mockImplementation((entry: EventMatchEntry) => {
        Object.assign(entry, { groupId: 'group-2', mergeOfferGroupId: null });
        return Promise.resolve();
      });

      const card = await service.acceptMerge('group-1', 'user-3');

      expect(formation.acceptMerge).toHaveBeenCalledWith(crisEntry);
      expect(card.id).toBe('group-2');
      expect(card.conversationId).toBe('conversation-2');
      expect(card.members).toEqual([
        expect.objectContaining({ slug: 'cris', isYou: true }),
      ]);
    });

    it('returns 404 without an offer and never calls formation', async () => {
      await expectRejection(
        service.acceptMerge('group-1', 'user-3'),
        NotFoundException,
      );
      expect(formation.acceptMerge).not.toHaveBeenCalled();
    });
  });
});
