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
import { EventPhoto } from '../events/entities/event-photo.entity';
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
  REPORT_DAILY_EMERGENCY_ALLOWANCE,
  REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE,
  REPORT_DAILY_EMERGENCY_CEILING,
  REPORT_DAILY_LIMIT,
  REPORT_DAILY_WINDOW_MS,
  REPORT_FLOOD_CAP_CODE,
  REPORT_PER_SUBJECT_CAP_MESSAGE,
  REPORT_PER_SUBJECT_LIMIT,
  REPORT_PER_SUBJECT_WINDOW_MS,
} from './report-flood-limits';
import { REASON_CODES, type ReasonCode } from './reason-catalogue';
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
  // The gathering-photo evidence snapshot reads this at filing time. Held on a
  // variable so the photo cases can seed a row and the other cases can assert
  // it is never even consulted.
  let eventPhotos: {
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
    eventPhotos = {
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
        { provide: getRepositoryToken(EventPhoto), useValue: eventPhotos },
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

    // The gathering-photo snapshot. An `event_photo` report is the one subject
    // whose entire content is an image, the uploader can delete that image (row,
    // crop AND stored object), and the drawer's thread block is empty for every
    // subject — so without this a moderator judging "is this photo outing
    // someone" inside a one-hour SLA has prose about a picture and nothing else.
    const PHOTO_ID = '7f1c0e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

    it('snapshots the reported gathering photo into evidence at filing time', async () => {
      eventPhotos.findOne.mockResolvedValue({
        id: PHOTO_ID,
        eventId: 'b2c3d4e5-6f70-4812-9a3b-4c5d6e7f8091',
        storageKey:
          'gathering-photos/11111111-2222-4333-8444-555555555555/66666666-7777-4888-8999-aaaaaaaaaaaa.jpg',
        uploaderId: '11111111-2222-4333-8444-555555555555',
        caption: 'Everyone at the after-party',
        createdAt: new Date('2026-08-20T21:30:00.000Z'),
      });

      await service.create('reporter-1', {
        subjectType: ReportSubjectType.EventPhoto,
        subjectId: PHOTO_ID,
        reasonCode: 'outing',
      });

      expect(eventPhotos.findOne).toHaveBeenCalledWith({
        where: { id: PHOTO_ID },
      });
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: [
            expect.objectContaining({
              type: 'photo-snapshot',
              photoId: PHOTO_ID,
              eventId: 'b2c3d4e5-6f70-4812-9a3b-4c5d6e7f8091',
              storageKey:
                'gathering-photos/11111111-2222-4333-8444-555555555555/66666666-7777-4888-8999-aaaaaaaaaaaa.jpg',
              caption: 'Everyone at the after-party',
              uploaderId: '11111111-2222-4333-8444-555555555555',
              uploadedAt: '2026-08-20T21:30:00.000Z',
            }) as unknown,
          ],
        }),
      );
    });

    // The snapshot holds the image BY REFERENCE and the platform keeps no copy
    // of the photograph (see `PhotoSnapshotEvidence`). This pins that: an
    // evidence entry that ever grows a `url`, a `dataUrl` or a second key is
    // a retained photo of an identifiable person after a takedown, and that is
    // a decision to take deliberately rather than to drift into.
    it('stores the photo by reference, never a copy or a resolved URL', async () => {
      eventPhotos.findOne.mockResolvedValue({
        id: PHOTO_ID,
        eventId: 'b2c3d4e5-6f70-4812-9a3b-4c5d6e7f8091',
        storageKey:
          'gathering-photos/11111111-2222-4333-8444-555555555555/66666666-7777-4888-8999-aaaaaaaaaaaa.jpg',
        uploaderId: '11111111-2222-4333-8444-555555555555',
        caption: null,
        createdAt: new Date('2026-08-20T21:30:00.000Z'),
      });

      await service.create('reporter-1', {
        subjectType: ReportSubjectType.EventPhoto,
        subjectId: PHOTO_ID,
        reasonCode: 'outing',
      });

      const savedCalls = reports.save.mock.calls as [
        { evidence: Record<string, unknown>[] },
      ][];
      const snapshot = savedCalls[0]?.[0].evidence[0] ?? {};
      expect(snapshot).not.toHaveProperty('url');
      expect(snapshot).not.toHaveProperty('fileUrl');
      expect(snapshot).not.toHaveProperty('presignedUrl');
      expect(snapshot).not.toHaveProperty('dataUrl');
      expect(snapshot).not.toHaveProperty('evidenceStorageKey');
    });

    // A photo already deleted when the report is filed still files a report.
    // The moderator loses the image and keeps the complaint, which is the right
    // trade: a photo being gone is not the same as nothing having happened, and
    // refusing the filing would hand the uploader a way to block reports by
    // deleting fast.
    it('degrades to no snapshot when the reported photo is already gone', async () => {
      eventPhotos.findOne.mockResolvedValue(null);

      await expect(
        service.create('reporter-1', {
          subjectType: ReportSubjectType.EventPhoto,
          subjectId: PHOTO_ID,
          reasonCode: 'outing',
        }),
      ).resolves.toBeDefined();

      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({ evidence: null }),
      );
    });

    // `subjectId` is a client-supplied `varchar` and `event_photos.id` is a
    // `uuid` column, so an arbitrary string must never reach the query: it would
    // be a Postgres 22P02 and a 500 on the filing path rather than a miss.
    it('skips the photo lookup for a subjectId that is not a uuid', async () => {
      await expect(
        service.create('reporter-1', {
          subjectType: ReportSubjectType.EventPhoto,
          subjectId: 'not-a-uuid',
          reasonCode: 'outing',
        }),
      ).resolves.toBeDefined();

      expect(eventPhotos.findOne).not.toHaveBeenCalled();
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({ evidence: null }),
      );
    });

    // The snapshot is scoped to the ONE subject that needs it. A photo lookup on
    // every filing would be a query per report for nothing, and a `photo-snapshot`
    // on a member or a post would be evidence about the wrong thing.
    it.each([
      ReportSubjectType.Member,
      ReportSubjectType.Post,
      ReportSubjectType.Event,
      ReportSubjectType.Community,
    ])('writes no photo snapshot for a %s report', async (subjectType) => {
      await service.create('reporter-1', {
        subjectType,
        subjectId: PHOTO_ID,
        reasonCode: 'harassment',
      });

      expect(eventPhotos.findOne).not.toHaveBeenCalled();
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({ evidence: null }),
      );
    });

    // PRD-22 / PRD-24. `outing` and `doxxing` are the whole Emergency band, so
    // a subject whose catalogue omits them can never reach the one-hour SLA no
    // matter what happened. Asserted through `create` rather than only against
    // the catalogue, because the catalogue change is half a fix if the filing
    // pipeline does not carry the reason into `deriveSeverity`.
    it.each([
      ReportSubjectType.Housing,
      ReportSubjectType.Flatmate,
      ReportSubjectType.Landlord,
      ReportSubjectType.Community,
    ])(
      'derives emergency severity for an outing report about %s',
      async (subjectType) => {
        const res = await service.create('reporter-1', {
          subjectType,
          subjectId: 'subject-1',
          reasonCode: 'outing',
        });

        expect(res.severity).toBe(ReportSeverity.Emergency);
        expect(reports.save).toHaveBeenCalledWith(
          expect.objectContaining({
            subjectType,
            reasonCode: 'outing',
            severity: ReportSeverity.Emergency,
          }),
        );
      },
    );

    // PRD-24: a community used to offer `hate_speech`, `spam` and `other` only,
    // so the harassment a community was actually doing had no word on the form.
    it('accepts a harassment report about a community', async () => {
      const res = await service.create('reporter-1', {
        subjectType: ReportSubjectType.Community,
        subjectId: 'trans-lisboa',
        reasonCode: 'harassment',
      });

      expect(res.severity).toBe(ReportSeverity.High);
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: ReportSubjectType.Community,
          subjectId: 'trans-lisboa',
          reasonCode: 'harassment',
        }),
      );
    });

    // PRD-30: `hate_speech` is in `MEDIUM_REASONS`, so a member reported for a
    // slur lands Medium (3 days), exactly where the `discrimination` filing it
    // replaces landed. It sits BELOW `harassment` (High), and the ceiling a
    // member report can reach is still Emergency through `outing` / `doxxing`
    // alone. Adding the code changed what the taxonomy can say, and it changed
    // no severity anywhere.
    it('lands a member hate_speech report in the medium band', async () => {
      const res = await service.create('reporter-1', {
        subjectType: ReportSubjectType.Member,
        subjectId: 'member-2',
        reasonCode: 'hate_speech',
      });

      expect(res.severity).toBe(ReportSeverity.Medium);
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
        /** Defaults to `REPORTER_ID`; set it to seed somebody else's filings. */
        reporterId?: string;
      }

      /** The reporter every fixture filing and every `fileReport` belongs to. */
      const REPORTER_ID = 'reporter-1';

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
                // The caps are per REPORTER, so the fixture has to be too:
                // answering with another member's rows would let a leak across
                // reporters pass unnoticed.
                (filing.reporterId ?? REPORTER_ID) === where.reporterId &&
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

      function fileReportAs(
        reporterId: string,
        reasonCode: ReasonCode = 'harassment',
      ): Promise<unknown> {
        return service.create(reporterId, {
          subjectType: ReportSubjectType.Post,
          subjectId: 'post-1',
          reasonCode,
        });
      }

      function fileReport(
        reasonCode: ReasonCode = 'harassment',
      ): Promise<unknown> {
        return fileReportAs(REPORTER_ID, reasonCode);
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

      // Both cap messages reach the member verbatim, so a pointer to a channel
      // the product does not have is a member in an urgent situation looking
      // for a door that is not there. QueerPulse has no member-to-moderator
      // inbox and sends no email; the Contact form (`POST /inquiries`, triaged
      // in the admin intake console) is the one route that exists.
      it.each([
        ['daily', REPORT_DAILY_CAP_MESSAGE],
        ['per-subject', REPORT_PER_SUBJECT_CAP_MESSAGE],
        [
          'exhausted emergency allowance',
          REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE,
        ],
      ])(
        'points an urgent member at a channel that exists (%s cap)',
        (_capName, message) => {
          expect(message).toContain('/about/contact');
          expect(message.toLowerCase()).not.toContain('moderator directly');
          expect(message.toLowerCase()).not.toContain('email');
        },
      );

      // The allowance refusal is read in the worst circumstances this endpoint
      // can produce: an emergency report, refused. It has to stay as plain and
      // as free of accusation as the two cap messages, and it must not leak
      // what happened to anything already filed.
      it('refuses an exhausted allowance without accusing anyone', () => {
        const message = REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE.toLowerCase();
        expect(message).toContain('moderation team');
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

      // PRD-23. The cap ran before severity was derived, so the fourth filing
      // against one subject was refused with a 429 even when it said `outing`:
      // the one class of report the platform promises a one-hour answer to was
      // the one this endpoint could turn away.
      describe('the emergency exemption on the per-subject cap', () => {
        /** `REPORT_PER_SUBJECT_LIMIT` earlier filings, all against `post-1`. */
        function seedSubjectAtItsCap(): void {
          seedFilings(
            Array.from(
              { length: REPORT_PER_SUBJECT_LIMIT },
              (_unused, index) => ({
                at: new Date(nowMs - (index + 1) * 24 * HOUR_MS),
                subjectId: 'post-1',
              }),
            ),
          );
        }

        it('still refuses a non-emergency filing on that same subject', async () => {
          seedSubjectAtItsCap();

          const refusal = await expectRefusedWith429(fileReport('harassment'));
          expect(refusal.cap).toBe('subject');
          expect(refusal.message).toBe(REPORT_PER_SUBJECT_CAP_MESSAGE);
        });

        it.each(['outing', 'doxxing'] as const)(
          'lets a %s filing through on the subject that just refused one',
          async (reasonCode) => {
            seedSubjectAtItsCap();

            await expect(fileReport(reasonCode)).resolves.toBeDefined();
            expect(reports.save).toHaveBeenCalledWith(
              expect.objectContaining({
                reasonCode,
                severity: ReportSeverity.Emergency,
              }),
            );
            // An exemption is an acceptance, so nothing about it belongs on the
            // refusal counter that moderation dashboards read.
            expect(metrics.incrementReportFloodRefusal).not.toHaveBeenCalled();
          },
        );

        it('logs the bypass under its own grep handle', async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          seedSubjectAtItsCap();

          await expect(fileReport('outing')).resolves.toBeDefined();

          expect(warn).toHaveBeenCalledTimes(1);
          const line = String(warn.mock.calls[0]?.[0] ?? '');
          expect(line).toContain('report-flood-cap-emergency-bypass');
          expect(line).toContain('cap=subject');
          expect(line).toContain('windowHours=168');
          expect(line).toContain('reporterId=reporter-1');
          expect(line).toContain('subjectId=post-1');
          expect(line).toContain('reasonCode=outing');
          // A search for refusals must never turn this line up.
          expect(line).not.toContain('report-flood-cap refused');
        });

        it('leaves the log silent when the subject cap has room', async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          seedFilings([{ at: new Date(nowMs - HOUR_MS), subjectId: 'post-1' }]);

          await expect(fileReport('outing')).resolves.toBeDefined();
          expect(warn).not.toHaveBeenCalled();
        });
      });

      // PRD-23 left the DAILY cap short-circuiting ahead of the per-subject
      // one, so the report the platform promises to answer within the hour was
      // still refusable, at report thirty-one instead of at the fourth on one
      // subject. The fix is an ALLOWANCE above the cap rather than an exemption
      // from it: exempting a reason code outright would hand any account an
      // unbounded filing channel for the price of typing `outing`.
      describe('the bounded emergency allowance above the daily cap', () => {
        /** The reporter sits exactly on `REPORT_DAILY_LIMIT`, no subject twice. */
        function seedReporterAtDailyCap(): void {
          seedFilings(spreadAcrossSubjects(REPORT_DAILY_LIMIT, HOUR_MS));
        }

        /** The reporter has spent the cap AND the whole allowance. */
        function seedReporterAtEmergencyCeiling(): void {
          seedFilings(
            spreadAcrossSubjects(REPORT_DAILY_EMERGENCY_CEILING, HOUR_MS),
          );
        }

        it('still refuses a non-emergency filing at the daily cap', async () => {
          seedReporterAtDailyCap();

          const refusal = await expectRefusedWith429(fileReport('harassment'));
          expect(refusal.cap).toBe('daily');
          expect(refusal.message).toBe(REPORT_DAILY_CAP_MESSAGE);
          expect(metrics.incrementReportFloodRefusal).toHaveBeenCalledWith(
            'daily',
          );
        });

        it.each(['outing', 'doxxing'] as const)(
          'lets a %s filing through at the daily cap',
          async (reasonCode) => {
            seedReporterAtDailyCap();

            await expect(fileReport(reasonCode)).resolves.toBeDefined();
            expect(reports.save).toHaveBeenCalledWith(
              expect.objectContaining({
                reasonCode,
                severity: ReportSeverity.Emergency,
              }),
            );
            // An allowance spent is an acceptance, so nothing reaches the
            // refusal counter a moderation dashboard reads.
            expect(metrics.incrementReportFloodRefusal).not.toHaveBeenCalled();
          },
        );

        it('lets an emergency filing through on the last slot of the allowance', async () => {
          seedFilings(
            spreadAcrossSubjects(REPORT_DAILY_EMERGENCY_CEILING - 1, HOUR_MS),
          );

          await expect(fileReport('outing')).resolves.toBeDefined();
          expect(reports.save).toHaveBeenCalled();
        });

        it('refuses an emergency filing once the allowance is spent', async () => {
          // The ceiling is absolute: past it the emergency band buys nothing,
          // which is what keeps `outing` from being an unbounded channel.
          seedReporterAtEmergencyCeiling();

          const refusal = await expectRefusedWith429(fileReport('outing'));
          expect(refusal.code).toBe(REPORT_FLOOD_CAP_CODE);
          expect(refusal.cap).toBe('daily');
          expect(refusal.message).toBe(
            REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE,
          );
          expect(emitter.emit).not.toHaveBeenCalled();
          // Refused by the daily ceiling, so it belongs on the daily series.
          // Leaving it off would make the worst refusals the invisible ones.
          expect(metrics.incrementReportFloodRefusal).toHaveBeenCalledWith(
            'daily',
          );
        });

        it('counts the allowance over the same rolling 24 hours as the cap', async () => {
          // Cap and allowance both spent, every one of them filed an hour past
          // the trailing boundary. A rolling window has to hand both back.
          seedFilings(
            spreadAcrossSubjects(
              REPORT_DAILY_EMERGENCY_CEILING,
              REPORT_DAILY_WINDOW_MS + HOUR_MS,
            ),
          );

          await expect(fileReport('outing')).resolves.toBeDefined();
          expect(reports.save).toHaveBeenCalled();
        });

        it('counts the allowance per reporter, never across reporters', async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          // Somebody else has filed past the ceiling in the last day.
          seedFilings(
            spreadAcrossSubjects(REPORT_DAILY_EMERGENCY_CEILING, HOUR_MS).map(
              (filing) => ({ ...filing, reporterId: 'reporter-2' }),
            ),
          );

          await expect(fileReport('outing')).resolves.toBeDefined();
          expect(reports.save).toHaveBeenCalled();
          // Nothing to write down: this reporter never reached a cap at all.
          expect(warn).not.toHaveBeenCalled();
        });

        it('logs the allowance bypass under the shared handle, marked daily', async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          seedReporterAtDailyCap();

          await expect(fileReport('outing')).resolves.toBeDefined();

          expect(warn).toHaveBeenCalledTimes(1);
          const line = String(warn.mock.calls[0]?.[0] ?? '');
          expect(line).toContain('report-flood-cap-emergency-bypass');
          // `cap=` is what tells this bypass from the per-subject one, which
          // logs `cap=subject` and an unbounded allowance.
          expect(line).toContain('cap=daily');
          expect(line).not.toContain('cap=subject');
          expect(line).toContain(
            `allowance=${REPORT_DAILY_EMERGENCY_ALLOWANCE}`,
          );
          expect(line).not.toContain('allowance=unbounded');
          expect(line).toContain('windowHours=24');
          expect(line).toContain(`filedInWindow=${REPORT_DAILY_LIMIT}`);
          expect(line).toContain('reporterId=reporter-1');
          expect(line).toContain('subjectId=post-1');
          expect(line).toContain('reasonCode=outing');
          // A search for refusals must never turn an acceptance up.
          expect(line).not.toContain('report-flood-cap refused');
        });

        it('keeps the per-subject bypass line distinguishable from the daily one', async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          // At the per-subject cap with the daily one wide open, so only the
          // per-subject bypass can fire.
          seedFilings(
            Array.from(
              { length: REPORT_PER_SUBJECT_LIMIT },
              (_unused, index) => ({
                at: new Date(nowMs - (index + 1) * 24 * HOUR_MS),
                subjectId: 'post-1',
              }),
            ),
          );

          await expect(fileReport('outing')).resolves.toBeDefined();

          const line = String(warn.mock.calls[0]?.[0] ?? '');
          expect(line).toContain('report-flood-cap-emergency-bypass');
          expect(line).toContain('cap=subject');
          expect(line).not.toContain('cap=daily');
          // The per-subject cap yields outright; the daily ceiling is what
          // bounds it, so there is no allowance number to print.
          expect(line).toContain('allowance=unbounded');
        });

        it('logs an exhausted allowance under its own grep handle', async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          seedReporterAtEmergencyCeiling();

          await expectRefusedWith429(fileReport('outing'));

          expect(warn).toHaveBeenCalledTimes(1);
          const line = String(warn.mock.calls[0]?.[0] ?? '');
          expect(line).toContain(
            'report-flood-cap-emergency-allowance-exhausted',
          );
          expect(line).toContain('cap=daily');
          expect(line).toContain(`limit=${REPORT_DAILY_LIMIT}`);
          expect(line).toContain(
            `allowance=${REPORT_DAILY_EMERGENCY_ALLOWANCE}`,
          );
          expect(line).toContain('windowHours=24');
          expect(line).toContain(
            `filedInWindow=${REPORT_DAILY_EMERGENCY_CEILING}`,
          );
          expect(line).toContain('reporterId=reporter-1');
          expect(line).toContain('reasonCode=outing');
          // Three handles, three searches. The refusal of an emergency filing
          // must not surface as an ordinary cap refusal, and must never be
          // mistaken for one that was let through.
          expect(line).not.toContain('report-flood-cap refused');
          expect(line).not.toContain('report-flood-cap-emergency-bypass');
          // The shared prefix still finds all three.
          expect(line).toContain('report-flood-cap');
        });
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

    // PRD-22 / PRD-24. `outing` and `doxxing` are the entire Emergency band, so
    // a subject that does not offer them cannot produce an emergency report at
    // all. Housing is where that bites hardest: a landlord threatening to tell
    // somebody's family, or a flatmate posting their address or transition
    // status, had no word on the form and topped out at High.
    it.each([
      ReportSubjectType.Housing,
      ReportSubjectType.Flatmate,
      ReportSubjectType.Landlord,
      ReportSubjectType.Community,
    ])('offers the emergency-band codes for %s', (subjectType) => {
      const codes = service
        .reasonsFor(subjectType)
        .map((option) => option.code);

      expect(codes).toContain('outing');
      expect(codes).toContain('doxxing');
      // First, matching the ordering `member` / `post` / `message` already use:
      // the two codes that carry the most danger lead the list.
      expect(codes.slice(0, 2)).toEqual(['outing', 'doxxing']);
    });

    // PRD-24: the community set was `hate_speech`, `spam`, `other`. Pinned
    // exactly, because this list is mirrored in the frontend's
    // `features/safety/reportReasons.ts` and a silent divergence between the
    // two is invisible until a member cannot report what happened to them.
    it('offers the full harm set for a community subject', () => {
      expect(
        service
          .reasonsFor(ReportSubjectType.Community)
          .map((option) => option.code),
      ).toEqual([
        'outing',
        'doxxing',
        'harassment',
        'hate_speech',
        'discrimination',
        'spam',
        'off_topic',
        'other',
      ]);
    });

    // PRD-30: reporting a person for a slur had no code, so it had to be filed
    // as `discrimination`. The severity band is the same either way, so this
    // pins the LIST rather than any outcome: the moderation queue and the
    // transparency report are counted from these codes, and without
    // `hate_speech` here the taxonomy said the platform receives hate-speech
    // reports about posts and none at all about people.
    it('offers the full harm set for a member subject', () => {
      expect(
        service
          .reasonsFor(ReportSubjectType.Member)
          .map((option) => option.code),
      ).toEqual([
        'outing',
        'doxxing',
        'harassment',
        'hate_speech',
        'unwanted_contact',
        'impersonation',
        'discrimination',
        'other',
      ]);
    });

    // The same gap, on the other three subjects that are a person or a member
    // account. Swept together because a slur is a slur whichever of these the
    // reporter is looking at, and a code offered on one of them and withheld on
    // the next is a taxonomy that miscounts rather than one that is stricter.
    it.each([
      ReportSubjectType.Member,
      ReportSubjectType.Flatmate,
      ReportSubjectType.Landlord,
      ReportSubjectType.Subprofile,
    ])('offers hate_speech for the person-shaped subject %s', (subjectType) => {
      const codes = service
        .reasonsFor(subjectType)
        .map((option) => option.code);

      expect(codes).toContain('hate_speech');
      // Placed directly after `harassment`, the slot every subject offering
      // both already uses (`post`, `reply`, `message`, `community`).
      expect(codes[codes.indexOf('harassment') + 1]).toBe('hate_speech');
    });

    // A code offered by `GET /reports/reasons` that is absent from
    // `REASON_CODES` renders as a selectable option whose filing the DTO's
    // `@IsIn(REASON_CODES)` then rejects with a 400. Swept across every subject
    // so widening one entry cannot introduce that shape unnoticed.
    it('offers only codes POST /reports will accept, for every subject', () => {
      for (const subjectType of Object.values(ReportSubjectType)) {
        for (const option of service.reasonsFor(subjectType)) {
          expect(REASON_CODES).toContain(option.code);
          expect(option.label).toBeTruthy();
        }
      }
    });
  });
});
