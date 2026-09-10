import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Event } from '../events/entities/event.entity';
import { CommunityPublicService } from './community-public.service';
import { CommunityMember } from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';

interface RecordedWhereCall {
  clause: string;
  parameters: Record<string, unknown>;
}

// A chainable stub for `listUpcomingGatherings`'s query builder. It records
// every `where` / `andWhere` call it is handed, so a test can read back the
// exact schedule predicate the service asked Postgres for and the values it
// bound. `getMany` resolves empty, which short-circuits `goingCountsFor`
// before it reaches `events.manager`.
const recordingGatheringsQueryBuilder = () => {
  const recordedWhereCalls: RecordedWhereCall[] = [];
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere']) {
    queryBuilder[method] = jest.fn((clause: unknown, parameters: unknown) => {
      if (typeof clause === 'string') {
        recordedWhereCalls.push({
          clause,
          parameters:
            parameters && typeof parameters === 'object'
              ? (parameters as Record<string, unknown>)
              : {},
        });
      }
      return queryBuilder;
    });
  }
  for (const method of ['orderBy', 'addOrderBy', 'offset', 'limit']) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue([]);
  return { queryBuilder, recordedWhereCalls };
};

const COMMUNITY = {
  id: 'community-1',
  slug: 'queer-devs',
  accessTier: AccessTier.Public,
  archivedAt: null,
};

describe('CommunityPublicService', () => {
  let service: CommunityPublicService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock; count: jest.Mock };
  let events: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn().mockResolvedValue(COMMUNITY) };
    members = {
      // A PROSPECTIVE member: visible community, no roster row. That is the
      // caller this endpoint exists for.
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    };
    events = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(
        () => recordingGatheringsQueryBuilder().queryBuilder,
      ),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityPublicService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();
    service = module.get(CommunityPublicService);
  });

  // Multi-day and overnight gatherings on the tab a PROSPECTIVE member reads.
  // A gathering that is UNDERWAY is upcoming, and this lane has to agree with
  // the member lane (`EventsService.listUpcomingByCommunity`) or the same
  // community shows two different calendars either side of the join button.
  //
  // There is no database here, so the tests work in two steps. The recording
  // query builder reads back the exact SQL string the service handed TypeORM,
  // and `matchesScheduleClause` pins what that string MEANS by stating the
  // same logic in JavaScript. A predicate the service changes without changing
  // the constant fails the first test; a predicate whose meaning drifts fails
  // the ones after it.
  describe('listUpcomingGatherings schedule predicate', () => {
    const UPCOMING_SCHEDULE_CLAUSE =
      '(gathering.start_at >= :now OR (gathering.end_at IS NOT NULL AND gathering.end_at >= :now))';

    const matchesScheduleClause = (
      clause: string,
      gathering: { startAt: Date; endAt: Date | null },
      now: Date,
    ): boolean => {
      if (clause !== UPCOMING_SCHEDULE_CLAUSE) {
        throw new Error(`No JavaScript reading for the clause: ${clause}`);
      }
      const startsAt = gathering.startAt.getTime();
      const endsAt = gathering.endAt ? gathering.endAt.getTime() : null;
      const nowInMilliseconds = now.getTime();
      return (
        startsAt >= nowInMilliseconds ||
        (endsAt !== null && endsAt >= nowInMilliseconds)
      );
    };

    // Runs the endpoint and returns the one call it built around `:now`,
    // having first checked that the `now` it bound is a real Date.
    const scheduleCall = async (): Promise<RecordedWhereCall> => {
      const { queryBuilder, recordedWhereCalls } =
        recordingGatheringsQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.listUpcomingGatherings('queer-devs', 'viewer-1', 1);
      const scheduleCalls = recordedWhereCalls.filter((call) =>
        call.clause.includes(':now'),
      );
      expect(scheduleCalls).toHaveLength(1);
      expect(scheduleCalls[0]!.parameters.now).toBeInstanceOf(Date);
      return scheduleCalls[0]!;
    };

    const scheduleClause = async (): Promise<string> =>
      (await scheduleCall()).clause;

    const now = new Date('2026-10-17T23:30:00.000Z');
    const HOUR_IN_MILLISECONDS = 3_600_000;
    const overnightPartyUnderway = {
      startAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() + 4 * HOUR_IN_MILLISECONDS),
    };
    const festivalOnItsSecondDay = {
      startAt: new Date(now.getTime() - 24 * HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() + 48 * HOUR_IN_MILLISECONDS),
    };
    const finished = {
      startAt: new Date(now.getTime() - 4 * HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
    };
    const startedWithNoStatedEnd = {
      startAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
      endAt: null,
    };

    it('builds the underway-aware predicate as one parenthesised conjunct', async () => {
      await expect(scheduleClause()).resolves.toBe(UPCOMING_SCHEDULE_CLAUSE);
    });

    it('keeps an overnight party that started at 23:00 on the tab', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, overnightPartyUnderway, now)).toBe(
        true,
      );
    });

    it('keeps a three-day festival on the tab on its second day', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, festivalOnItsSecondDay, now)).toBe(
        true,
      );
    });

    it('drops a gathering that ended an hour ago', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, finished, now)).toBe(false);
    });

    // A gathering that states no end is over once it has started, which is
    // what browse's `past` branch and `hasEnded` both say. The `IS NOT NULL`
    // arm is what holds that line here.
    it('drops a started gathering with no stated end', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, startedWithNoStatedEnd, now)).toBe(
        false,
      );
    });

    // The visibility allow-list and the takedown check sit beside the schedule
    // disjunct as their own conjuncts. The schedule's `OR` has to stay inside
    // its own parentheses, because unparenthesised it would bind loosely
    // enough to widen them and a members-only or hidden gathering would ride
    // in on a start date alone. Each clause reaching the builder as a separate
    // `andWhere` is the other half of that guarantee.
    it('keeps the schedule disjunct sealed beside the visibility and takedown filters', async () => {
      const { queryBuilder, recordedWhereCalls } =
        recordingGatheringsQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.listUpcomingGatherings('queer-devs', 'viewer-1', 1);
      const clauses = recordedWhereCalls.map((call) => call.clause);
      expect(
        clauses.some((clause) =>
          clause.includes('gathering.visibility IN (:...visibleTiers)'),
        ),
      ).toBe(true);
      expect(clauses.some((clause) => clause.includes('NOT EXISTS'))).toBe(
        true,
      );
      const scheduleClauseText = clauses.find((clause) =>
        clause.includes(':now'),
      )!;
      // The whole disjunct is one balanced group: the opening bracket closes
      // only at the very end, so every `OR` inside it stays inside it.
      let depth = 0;
      let closesEarly = false;
      for (let index = 0; index < scheduleClauseText.length; index += 1) {
        const character = scheduleClauseText[index];
        if (character === '(') depth += 1;
        if (character === ')') depth -= 1;
        if (depth === 0 && index < scheduleClauseText.length - 1) {
          closesEarly = true;
        }
      }
      expect(closesEarly).toBe(false);
      expect(depth).toBe(0);
    });
  });
});
