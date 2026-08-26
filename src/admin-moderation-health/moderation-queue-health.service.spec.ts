import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { BanRatification } from '../moderation/entities/ban-ratification.entity';
import { Report } from '../reports/entities/report.entity';
import { User } from '../users/entities/user.entity';
import { VerificationRequest } from '../verification/entities/verification-request.entity';
import { ModerationQueueHealthService } from './moderation-queue-health.service';
import { ModerationQueueKey } from './moderation-queue-thresholds';

const HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = new Date('2026-08-26T12:00:00.000Z');

function hoursAgo(hours: number): Date {
  return new Date(FIXED_NOW.getTime() - hours * HOUR_MS);
}

/** One aggregate row exactly as the pg driver hands it back: counts as
 *  strings (bigint), the MIN as a Date or null. */
interface RawAggregate {
  depth: string | null;
  overdueCount: string | null;
  unassignedCount: string | null;
  oldestCreatedAt: Date | null;
}

interface MockQueryBuilder {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  setParameter: jest.Mock;
  getRawOne: jest.Mock;
  getRawMany: jest.Mock;
}

function emptyAggregate(): RawAggregate {
  return {
    depth: '0',
    overdueCount: '0',
    unassignedCount: '0',
    oldestCreatedAt: null,
  };
}

function makeQueryBuilder(
  rawOne: RawAggregate | undefined,
  rawMany: { hours: string }[] = [],
): MockQueryBuilder {
  const builder = {} as MockQueryBuilder;
  builder.select = jest.fn(() => builder);
  builder.addSelect = jest.fn(() => builder);
  builder.where = jest.fn(() => builder);
  builder.setParameter = jest.fn(() => builder);
  builder.getRawOne = jest.fn().mockResolvedValue(rawOne);
  builder.getRawMany = jest.fn().mockResolvedValue(rawMany);
  return builder;
}

interface MockRepo {
  createQueryBuilder: jest.Mock;
  count: jest.Mock;
  metadata: { name: string; findColumnWithPropertyName: jest.Mock };
}

/**
 * The service resolves every raw column name from entity metadata in its
 * CONSTRUCTOR and throws when a property has gone missing, so that a rename
 * elsewhere fails the boot instead of silently disarming the hourly alert.
 * The mock therefore has to answer that lookup, and the snake-casing below is
 * the same `SnakeNamingStrategy` mapping the real metadata would return.
 */
function toSnakeCase(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function makeRepo(entityName = 'MockEntity'): MockRepo {
  return {
    createQueryBuilder: jest.fn(() => makeQueryBuilder(emptyAggregate())),
    count: jest.fn().mockResolvedValue(0),
    metadata: {
      name: entityName,
      findColumnWithPropertyName: jest.fn((property: string) => ({
        databaseName: toSnakeCase(property),
      })),
    },
  };
}

describe('ModerationQueueHealthService', () => {
  let service: ModerationQueueHealthService;
  let joinRequests: MockRepo;
  let reports: MockRepo;
  let appeals: MockRepo;
  let verificationRequests: MockRepo;
  let banRatifications: MockRepo;
  let users: MockRepo;
  let metrics: { recordModerationQueueHealth: jest.Mock };

  /**
   * `join_requests` is the one repository queried TWICE in a pass (the
   * pending aggregate in the first wave, then the median-response query in the
   * second), so its builder is handed over in that order.
   */
  function setUpJoinRequests(
    aggregate: RawAggregate,
    responseDeltas: { hours: string }[] = [],
  ): void {
    joinRequests.createQueryBuilder
      .mockReturnValueOnce(makeQueryBuilder(aggregate))
      .mockReturnValueOnce(makeQueryBuilder(undefined, responseDeltas));
  }

  function setUpAggregate(repo: MockRepo, aggregate: RawAggregate): void {
    repo.createQueryBuilder.mockReturnValue(makeQueryBuilder(aggregate));
  }

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    joinRequests = makeRepo('PlatformJoinRequest');
    reports = makeRepo('Report');
    appeals = makeRepo('Appeal');
    verificationRequests = makeRepo('VerificationRequest');
    banRatifications = makeRepo('BanRatification');
    users = makeRepo('User');
    metrics = { recordModerationQueueHealth: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationQueueHealthService,
        {
          provide: getRepositoryToken(PlatformJoinRequest),
          useValue: joinRequests,
        },
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Appeal), useValue: appeals },
        {
          provide: getRepositoryToken(VerificationRequest),
          useValue: verificationRequests,
        },
        {
          provide: getRepositoryToken(BanRatification),
          useValue: banRatifications,
        },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    service = moduleRef.get(ModerationQueueHealthService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('when every queue is healthy', () => {
    it('reports ok everywhere, with no breaches', async () => {
      setUpJoinRequests({
        depth: '2',
        overdueCount: '0',
        unassignedCount: '1',
        oldestCreatedAt: hoursAgo(3),
      });
      users.count.mockResolvedValue(4);

      const health = await service.getQueueHealth();

      expect(health.overallSeverity).toBe('ok');
      expect(health.activeModeratorCount).toBe(4);
      expect(health.queues).toHaveLength(5);
      for (const queue of health.queues) {
        expect(queue.severity).toBe('ok');
        expect(queue.breaches).toEqual([]);
      }
    });

    it('maps the invite queue numbers, including the per-moderator load', async () => {
      setUpJoinRequests({
        depth: '8',
        overdueCount: '0',
        unassignedCount: '3',
        oldestCreatedAt: hoursAgo(5),
      });
      users.count.mockResolvedValue(4);

      const health = await service.getQueueHealth();
      const inviteRequests = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.InviteRequests,
      );

      expect(inviteRequests).toMatchObject({
        depth: 8,
        overdueCount: 0,
        unassignedCount: 3,
        oldestItemHours: 5,
        depthPerModerator: 2,
        severity: 'ok',
      });
    });

    it('leaves the oldest age null on an empty queue rather than reading it as zero hours', async () => {
      users.count.mockResolvedValue(2);

      const health = await service.getQueueHealth();
      const reportsQueue = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.Reports,
      );

      expect(reportsQueue?.depth).toBe(0);
      expect(reportsQueue?.oldestItemHours).toBeNull();
      expect(reportsQueue?.severity).toBe('ok');
    });

    it('reports a null per-moderator load when there are no active moderators', async () => {
      users.count.mockResolvedValue(0);

      const health = await service.getQueueHealth();

      expect(health.activeModeratorCount).toBe(0);
      for (const queue of health.queues) {
        expect(queue.depthPerModerator).toBeNull();
      }
    });
  });

  describe('when one queue is over its warning level', () => {
    it('marks that queue warning and lifts the overall severity with it', async () => {
      // The reports depth band is 10 / 25.
      setUpAggregate(reports, {
        depth: '12',
        overdueCount: '0',
        unassignedCount: '5',
        oldestCreatedAt: hoursAgo(2),
      });
      users.count.mockResolvedValue(4);

      const health = await service.getQueueHealth();
      const reportsQueue = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.Reports,
      );

      expect(reportsQueue?.severity).toBe('warning');
      expect(reportsQueue?.breaches).toEqual(['depth']);
      expect(reportsQueue?.depthPerModerator).toBe(3);
      expect(health.overallSeverity).toBe('warning');
      // Every other queue is untouched by one queue's trouble.
      const appealsQueue = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.Appeals,
      );
      expect(appealsQueue?.severity).toBe('ok');
    });
  });

  describe('when one queue is over its critical level', () => {
    it('marks it critical on depth alone', async () => {
      setUpAggregate(reports, {
        depth: '30',
        overdueCount: '0',
        unassignedCount: '30',
        oldestCreatedAt: hoursAgo(2),
      });
      users.count.mockResolvedValue(4);

      const health = await service.getQueueHealth();
      const reportsQueue = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.Reports,
      );

      expect(reportsQueue?.severity).toBe('critical');
      expect(reportsQueue?.breaches).toEqual(['depth']);
      expect(health.overallSeverity).toBe('critical');
    });

    it('goes critical on age alone, however shallow the queue is', async () => {
      // A single invite request, 80 hours old: past the published three-day
      // window, which is the invite queue's own critical level.
      setUpJoinRequests({
        depth: '1',
        overdueCount: '1',
        unassignedCount: '1',
        oldestCreatedAt: hoursAgo(80),
      });
      users.count.mockResolvedValue(4);

      const health = await service.getQueueHealth();
      const inviteRequests = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.InviteRequests,
      );

      expect(inviteRequests?.depth).toBe(1);
      expect(inviteRequests?.severity).toBe('critical');
      expect(inviteRequests?.breaches).toEqual(['oldest', 'overdue']);
      expect(health.overallSeverity).toBe('critical');
    });

    it('takes the worst queue, never an average of them', async () => {
      setUpAggregate(banRatifications, {
        depth: '6',
        overdueCount: '0',
        unassignedCount: '0',
        oldestCreatedAt: hoursAgo(1),
      });
      users.count.mockResolvedValue(6);

      const health = await service.getQueueHealth();
      const okQueues = health.queues.filter((queue) => queue.severity === 'ok');

      expect(okQueues).toHaveLength(4);
      expect(health.overallSeverity).toBe('critical');
    });
  });

  describe('the queues with no assignment column', () => {
    it('reports a null unassigned count rather than a zero', async () => {
      users.count.mockResolvedValue(3);

      const health = await service.getQueueHealth();
      const appealsQueue = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.Appeals,
      );
      const banRatificationsQueue = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.BanRatifications,
      );

      expect(appealsQueue?.unassignedCount).toBeNull();
      expect(banRatificationsQueue?.unassignedCount).toBeNull();
    });
  });

  describe('which rows count as waiting', () => {
    it('counts a waitlisted invite request, whose three-day clock is still running', async () => {
      const builder = makeQueryBuilder(emptyAggregate());
      joinRequests.createQueryBuilder
        .mockReturnValueOnce(builder)
        .mockReturnValueOnce(makeQueryBuilder(undefined, []));
      users.count.mockResolvedValue(3);

      await service.getQueueHealth();

      // `due_at` is stamped at submission and never cleared by waitlisting, so
      // a waitlisted applicant is still owed an answer inside the published
      // window. Counting only `pending` would report thirty three-week-old
      // waitlisted requests as an empty, healthy queue.
      const [predicate, parameters] = builder.where.mock.calls[0] as [
        string,
        { openStatuses: string[] },
      ];
      expect(predicate).toContain('joinRequest.status IN');
      expect(parameters.openStatuses).toEqual(['pending', 'waitlisted']);
    });

    it('counts a verification request parked in review, not only a pending one', async () => {
      const builder = makeQueryBuilder(emptyAggregate());
      verificationRequests.createQueryBuilder.mockReturnValue(builder);
      users.count.mockResolvedValue(3);

      await service.getQueueHealth();

      const [, parameters] = builder.where.mock.calls[0] as [
        string,
        { openStatuses: string[] },
      ];
      expect(parameters.openStatuses).toEqual([
        'pending',
        'in_review',
        'appealing',
      ]);
    });
  });

  describe('the raw column names the aggregates splice in', () => {
    it('refuses to construct when a property it depends on has been renamed', () => {
      const brokenReports = makeRepo('Report');
      brokenReports.metadata.findColumnWithPropertyName = jest.fn(
        (property: string) =>
          property === 'slaDueAt'
            ? undefined
            : { databaseName: toSnakeCase(property) },
      );

      // A rename elsewhere must fail the BOOT loudly. The alternative is
      // `undefined` spliced into a SQL string and a syntax error raised once
      // an hour inside a cron that logs it and moves on, which reads to
      // everyone as the alert simply never firing.
      expect(
        () =>
          new ModerationQueueHealthService(
            joinRequests as never,
            brokenReports as never,
            appeals as never,
            verificationRequests as never,
            banRatifications as never,
            users as never,
            metrics as never,
          ),
      ).toThrow(/Report has no property "slaDueAt"/);
    });
  });

  describe('the invite queue median response time', () => {
    it('is the shared median of the decisions inside the window', async () => {
      setUpJoinRequests(emptyAggregate(), [
        { hours: '10' },
        { hours: '2' },
        { hours: '6' },
      ]);
      users.count.mockResolvedValue(3);

      const health = await service.getQueueHealth();
      const inviteRequests = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.InviteRequests,
      );

      expect(inviteRequests?.medianResponseHours).toBe(6);
    });

    it('is null when nothing was decided inside the window', async () => {
      setUpJoinRequests(emptyAggregate(), []);
      users.count.mockResolvedValue(3);

      const health = await service.getQueueHealth();
      const inviteRequests = health.queues.find(
        (queue) => queue.queue === ModerationQueueKey.InviteRequests,
      );

      expect(inviteRequests?.medianResponseHours).toBeNull();
    });
  });

  describe('Prometheus gauges', () => {
    it('publishes the same measurement it serves', async () => {
      setUpAggregate(reports, {
        depth: '12',
        overdueCount: '4',
        unassignedCount: '2',
        oldestCreatedAt: hoursAgo(30),
      });
      users.count.mockResolvedValue(5);

      const health = await service.getQueueHealth();

      expect(metrics.recordModerationQueueHealth).toHaveBeenCalledTimes(1);
      expect(metrics.recordModerationQueueHealth).toHaveBeenCalledWith(health);
    });
  });
});
