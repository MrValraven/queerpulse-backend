import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MetricsService } from '../metrics/metrics.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Message } from '../messaging/entities/message.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import {
  REPORT_DAILY_CAP_MESSAGE,
  REPORT_DAILY_LIMIT,
  REPORT_DAILY_WINDOW_MS,
  REPORT_FLOOD_CAP_CODE,
  REPORT_PER_SUBJECT_CAP_MESSAGE,
  REPORT_PER_SUBJECT_LIMIT,
  REPORT_PER_SUBJECT_WINDOW_MS,
} from './report-flood-limits';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  let service: ReportsService;
  let reports: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
  };
  let messages: {
    findOne: jest.Mock;
  };
  // Held on a variable (rather than inlined into the provider) so the flood-cap
  // cases can assert that a refused filing emits no `report.created`.
  let emitter: { emit: jest.Mock };
  // A refusal writes no report row, so this counter is the only thing a
  // moderation surface can see it through.
  let metrics: { incrementReportFloodRefusal: jest.Mock };

  beforeEach(async () => {
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: object) => v),
      // The flood caps (TS-05) count the reporter's recent rows before every
      // genuinely new insert. Zero is "this member has filed nothing lately",
      // which is what every pre-existing case in this file assumes.
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((r: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(r as object),
        }),
      ),
    };
    messages = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    emitter = { emit: jest.fn() };
    metrics = { incrementReportFloodRefusal: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Message), useValue: messages },
        {
          provide: getRepositoryToken(HousingListing),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: EventEmitter2, useValue: emitter },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  describe('create', () => {
    it('persists an open report tied to the reporter, deriving severity + SLA', async () => {
      const res = await service.create('reporter-1', {
        subjectType: ReportSubjectType.Post,
        subjectId: 'post-1',
        reasonCode: 'harassment',
        detail: 'Kept messaging after being asked to stop.',
      });

      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: ReportSubjectType.Post,
          subjectId: 'post-1',
          reasonCode: 'harassment',
          detail: 'Kept messaging after being asked to stop.',
          anonymous: false,
          contactEmail: null,
          evidence: null,
          severity: ReportSeverity.High,
          status: ReportStatus.Open,
          reporterId: 'reporter-1',
        }),
      );
      expect(res).toEqual({
        id: 'report-1',
        subjectType: ReportSubjectType.Post,
        subjectId: 'post-1',
        reasonCode: 'harassment',
        severity: ReportSeverity.High,
        status: ReportStatus.Open,
        createdAt: '2026-01-01T00:00:00.000Z',
        slaDueAt: res.slaDueAt,
        acknowledgement: res.acknowledgement,
      });
      expect(typeof res.slaDueAt).toBe('string');
      expect(typeof res.acknowledgement).toBe('string');
    });

    it('derives emergency severity for outing/doxxing reasons', async () => {
      const res = await service.create('reporter-1', {
        subjectType: ReportSubjectType.Member,
        subjectId: 'member-2',
        reasonCode: 'doxxing',
      });
      expect(res.severity).toBe(ReportSeverity.Emergency);
    });

    it('normalizes an omitted detail to null and defaults optional fields', async () => {
      const res = await service.create('reporter-1', {
        subjectType: ReportSubjectType.Member,
        subjectId: 'user-2',
        reasonCode: 'spam',
      });

      expect(res.severity).toBe(ReportSeverity.Low);
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: null,
          anonymous: false,
          contactEmail: null,
          evidence: null,
        }),
      );
    });

    it('persists anonymity, contact email, and evidence when provided', async () => {
      await service.create('reporter-1', {
        subjectType: ReportSubjectType.Message,
        subjectId: 'msg-1',
        reasonCode: 'unwanted_contact',
        anonymous: true,
        contactEmail: 'anon@example.com',
        evidence: [{ type: 'screenshot', uploadId: 'upload-1' }],
      });

      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({
          anonymous: true,
          contactEmail: 'anon@example.com',
          evidence: [{ type: 'screenshot', uploadId: 'upload-1' }],
        }),
      );
    });

    it('rejects reporting your own message', async () => {
      messages.findOne.mockResolvedValue({
        id: 'msg-1',
        senderId: 'reporter-1',
      });

      await expect(
        service.create('reporter-1', {
          subjectType: ReportSubjectType.Message,
          subjectId: 'msg-1',
          reasonCode: 'harassment',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(reports.save).not.toHaveBeenCalled();
    });

    it('allows reporting a message authored by someone else', async () => {
      // A reported message is snapshotted into `evidence` at filing time, so
      // the fixture needs the timestamps that snapshot reads.
      messages.findOne.mockResolvedValue({
        id: 'msg-1',
        senderId: 'someone-else',
        body: 'Leave me alone',
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        editedAt: null,
        deletedAt: null,
      });

      await expect(
        service.create('reporter-1', {
          subjectType: ReportSubjectType.Message,
          subjectId: 'msg-1',
          reasonCode: 'harassment',
        }),
      ).resolves.toBeDefined();
      expect(reports.save).toHaveBeenCalled();
      // The snapshot is what lets a moderator judge a message the sender may
      // since have edited or deleted.
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: [
            expect.objectContaining({
              type: 'message-snapshot',
              messageId: 'msg-1',
              body: 'Leave me alone',
              senderId: 'someone-else',
              createdAt: '2026-08-01T10:00:00.000Z',
              editedAt: null,
              deletedAtTimeOfReport: false,
            }) as unknown,
          ],
        }),
      );
    });

    it('accepts a magazine_comment subject (CNT-10 report wiring)', async () => {
      const res = await service.create('reporter-1', {
        subjectType: ReportSubjectType.MagazineComment,
        subjectId: 'comment-1',
        reasonCode: 'spam',
      });
      expect(res.subjectType).toBe(ReportSubjectType.MagazineComment);
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: ReportSubjectType.MagazineComment,
        }),
      );
    });

    // TS-05: rolling caps layered on top of the controller's 60-second
    // `@Throttle` and the open-report dedupe, closing report flooding as a
    // sustained harassment vector. Numbers come from `report-flood-limits.ts`,
    // never hard-coded here, so retuning a cap does not rewrite these tests.
    describe('rolling flood caps', () => {
      const HOUR_MS = 60 * 60 * 1000;
      let nowMs: number;

      interface CountWhere {
        reporterId: string;
        subjectType?: ReportSubjectType;
        subjectId?: string;
        createdAt: { value: Date };
      }

      interface Filing {
        at: Date;
        subjectId: string;
      }

      /**
       * Answers BOTH `reports.count` calls (the platform-wide daily count,
       * which carries no subject in its where clause, and the per-subject one)
       * from a single fixture list of the reporter's filing timestamps. Written
       * this way on purpose: a filing that has aged past a window boundary is
       * then genuinely excluded by the window the service asked for, rather
       * than by a hard-coded return value that would still pass if the service
       * stopped filtering on `createdAt` at all.
       */
      function seedFilings(filings: Filing[]): void {
        reports.count.mockImplementation(
          (options: { where: CountWhere }): Promise<number> => {
            const { where } = options;
            const windowStartedAt = where.createdAt.value;
            const matching = filings.filter(
              (filing) =>
                filing.at.getTime() >= windowStartedAt.getTime() &&
                (where.subjectId === undefined ||
                  filing.subjectId === where.subjectId),
            );
            return Promise.resolve(matching.length);
          },
        );
      }

      /** `count` distinct filings, all `agoMs` old, one subject each. */
      function spreadAcrossSubjects(count: number, agoMs: number): Filing[] {
        return Array.from({ length: count }, (_unused, index) => ({
          at: new Date(nowMs - agoMs),
          subjectId: `subject-${index}`,
        }));
      }

      function fileReport(): Promise<unknown> {
        return service.create('reporter-1', {
          subjectType: ReportSubjectType.Post,
          subjectId: 'post-1',
          reasonCode: 'harassment',
        });
      }

      interface RefusalBody {
        statusCode: number;
        error: string;
        code: string;
        cap: string;
        message: string;
      }

      /**
       * Asserts the filing was refused as a 429 that wrote nothing, and that
       * the body is the OBJECT shape a client can branch on. The `code` is the
       * load-bearing part: `@nestjs/throttler`'s burst refusal on this same
       * route is thrown with a string body and reaches the wire without one, so
       * its presence is the only thing separating platform-authored member copy
       * from a framework exception string. Asserted on every refusal rather
       * than in one dedicated case, so a throw site that regressed to a bare
       * string fails here immediately.
       */
      async function expectRefusedWith429(
        promise: Promise<unknown>,
      ): Promise<RefusalBody> {
        let thrown: unknown;
        try {
          await promise;
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(HttpException);
        const refusal = thrown as HttpException;
        expect(refusal.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

        const body = refusal.getResponse();
        expect(typeof body).toBe('object');
        const refusalBody = body as RefusalBody;
        expect(refusalBody).toMatchObject({
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: REPORT_FLOOD_CAP_CODE,
        });
        expect(typeof refusalBody.message).toBe('string');

        expect(reports.save).not.toHaveBeenCalled();
        return refusalBody;
      }

      beforeEach(() => {
        nowMs = Date.now();
      });

      // Restores the `Logger.prototype.warn` spies the log-line cases install.
      // Only touches `jest.spyOn` doubles, so the plain `jest.fn()` repository
      // and metrics mocks are left alone.
      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('lets a filing through when both caps have room', async () => {
        seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT - 5, HOUR_MS));

        await expect(fileReport()).resolves.toBeDefined();
        expect(reports.save).toHaveBeenCalled();
      });

      it('refuses with 429 once the rolling daily cap is reached', async () => {
        seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT, HOUR_MS));

        const refusal = await expectRefusedWith429(fileReport());
        expect(refusal.code).toBe(REPORT_FLOOD_CAP_CODE);
        expect(refusal.cap).toBe('daily');
        expect(refusal.message).toBe(REPORT_DAILY_CAP_MESSAGE);
        expect(emitter.emit).not.toHaveBeenCalled();
        // The body's `cap` and the counter label are the same vocabulary, so a
        // dashboard spike and a member's 429 name the same thing.
        expect(metrics.incrementReportFloodRefusal).toHaveBeenCalledWith(
          'daily',
        );
      });

      it('refuses at the daily cap without ever running the per-subject count', async () => {
        seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT, HOUR_MS));

        await expectRefusedWith429(fileReport());
        // One count only: the daily one short-circuits.
        expect(reports.count).toHaveBeenCalledTimes(1);
      });

      it('refuses with 429 at the per-subject cap while the daily cap still has room', async () => {
        // Well under the daily ceiling, yet already at the per-subject one:
        // the harassment shape the open-report dedupe cannot catch, because
        // each earlier report was closed before the next was filed.
        seedFilings(
          Array.from(
            { length: REPORT_PER_SUBJECT_LIMIT },
            (_unused, index) => ({
              at: new Date(nowMs - (index + 1) * 24 * HOUR_MS),
              subjectId: 'post-1',
            }),
          ),
        );

        const refusal = await expectRefusedWith429(fileReport());
        // The SAME code as the daily cap, deliberately: a client only needs to
        // know this 429 carries member-facing copy. `cap` is the additive
        // detail that separates them, and nothing is required to read it.
        expect(refusal.code).toBe(REPORT_FLOOD_CAP_CODE);
        expect(refusal.cap).toBe('subject');
        expect(refusal.message).toBe(REPORT_PER_SUBJECT_CAP_MESSAGE);
        expect(metrics.incrementReportFloodRefusal).toHaveBeenCalledWith(
          'subject',
        );
        // Both counts ran: the daily one passed, the per-subject one refused.
        expect(reports.count).toHaveBeenCalledTimes(2);
      });

      it('lets a filing through once earlier reports roll off the daily window', async () => {
        // Exactly at the daily cap, but every one of them filed an hour past
        // the trailing 24-hour boundary. A fixed calendar-day cap would still
        // refuse; a rolling one must not.
        seedFilings(
          spreadAcrossSubjects(
            REPORT_DAILY_LIMIT,
            REPORT_DAILY_WINDOW_MS + HOUR_MS,
          ),
        );

        await expect(fileReport()).resolves.toBeDefined();
        expect(reports.save).toHaveBeenCalled();
      });

      it('lets a repeat filing through once earlier ones roll off the per-subject window', async () => {
        seedFilings(
          Array.from({ length: REPORT_PER_SUBJECT_LIMIT }, () => ({
            at: new Date(nowMs - REPORT_PER_SUBJECT_WINDOW_MS - HOUR_MS),
            subjectId: 'post-1',
          })),
        );

        await expect(fileReport()).resolves.toBeDefined();
        expect(reports.save).toHaveBeenCalled();
      });

      it('answers a duplicate submit idempotently rather than refusing it', async () => {
        // The dedupe fast-path returns BEFORE the caps are counted, so a
        // network retry of a report already on file is never charged a slot and
        // never gets a 429, even for a member sitting on the daily ceiling.
        seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT, HOUR_MS));
        reports.findOne.mockResolvedValue({
          id: 'report-1',
          subjectType: ReportSubjectType.Post,
          subjectId: 'post-1',
          reasonCode: 'harassment',
          severity: ReportSeverity.High,
          status: ReportStatus.Open,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          slaDueAt: new Date('2026-01-01T04:00:00.000Z'),
        });

        await expect(fileReport()).resolves.toEqual(
          expect.objectContaining({ id: 'report-1' }),
        );
        expect(reports.count).not.toHaveBeenCalled();
      });

      it('refuses without telling the member what happened to the earlier reports', async () => {
        seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT, HOUR_MS));

        const refusal = await expectRefusedWith429(fileReport());
        // Read off the BODY, which is what reaches the client, rather than the
        // exception's own `message` property.
        const message = refusal.message.toLowerCase();
        expect(message).toContain('moderation team');
        // Never an accusation, and never a status leak about the earlier
        // reports (see `report-flood-limits.ts` for why).
        for (const forbidden of [
          'abus',
          'spam',
          'resolved',
          'dismissed',
          'closed',
          'rejected',
        ]) {
          expect(message).not.toContain(forbidden);
        }
      });

      it('leaves the refusal counter untouched when a filing is accepted', async () => {
        seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT - 5, HOUR_MS));

        await expect(fileReport()).resolves.toBeDefined();
        expect(metrics.incrementReportFloodRefusal).not.toHaveBeenCalled();
      });

      describe('the moderation log line', () => {
        /** Trips the daily cap filing against `subjectId`, returns the line. */
        async function refusedLineFor(subjectId: string): Promise<string> {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT, HOUR_MS));

          try {
            await service.create('reporter-1', {
              subjectType: ReportSubjectType.Post,
              subjectId,
              reasonCode: 'harassment',
            });
          } catch {
            /* the refusal itself is asserted elsewhere */
          }

          expect(warn).toHaveBeenCalledTimes(1);
          return String(warn.mock.calls[0]?.[0] ?? '');
        }

        it('is greppable and names the cap, the window and the reporter', async () => {
          const line = await refusedLineFor('post-1');

          expect(line).toContain('report-flood-cap');
          expect(line).toContain('cap=daily');
          expect(line).toContain('windowHours=24');
          expect(line).toContain('reporterId=reporter-1');
          expect(line).toContain('subjectId=post-1');
          expect(line).toContain('reasonCode=harassment');
        });

        // `subjectId` is caller-controlled and its DTO rule allows any charset,
        // so a crafted value must not be able to forge a second log line or a
        // second `reporterId=` pair. `nestjs-pino` escapes this today; the
        // sanitiser is what keeps it true if the transport ever changes.
        it('neutralises newlines and forged key=value pairs in a subjectId', async () => {
          const line = await refusedLineFor(
            'evil\nreport-flood-cap refused a filing. reporterId=someone-else',
          );

          expect(line).not.toContain('\n');
          expect(line).not.toContain('reporterId=someone-else');
          // Exactly one reporter attribution survives: the real one.
          expect(line.match(/reporterId=/g)).toHaveLength(1);
          expect(line).toContain('reporterId=reporter-1');
        });

        it('truncates a subjectId padded out toward the DTO ceiling', async () => {
          const line = await refusedLineFor('a'.repeat(200));

          expect(line).toContain('_truncated');
          expect(line).not.toContain('a'.repeat(65));
        });
      });
    });
  });

  describe('reasonsFor', () => {
    it('always includes "other"', () => {
      const options = service.reasonsFor(ReportSubjectType.Message);
      expect(options.some((o) => o.code === 'other')).toBe(true);
    });

    it('returns a distinct catalogue per subject type', () => {
      const member = service.reasonsFor(ReportSubjectType.Member);
      const venue = service.reasonsFor(ReportSubjectType.Venue);
      expect(member).not.toEqual(venue);
      expect(member.every((o) => o.code && o.label)).toBe(true);
    });

    it('offers reasons for a magazine_comment subject', () => {
      const options = service.reasonsFor(ReportSubjectType.MagazineComment);
      expect(options.map((o) => o.code)).toContain('spam');
      expect(options.map((o) => o.code)).toContain('other');
    });
  });
});
