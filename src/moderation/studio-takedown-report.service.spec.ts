import { EntityManager } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { StudioTrack } from '../studio/entities/studio-track.entity';
import {
  STUDIO_RELEASE_REPORTS_PREDICATE,
  StudioTakedownReportService,
} from './studio-takedown-report.service';

const NAMED_REPORT_ID = 'f1000000-0000-4000-8000-0000000000aa';
const SECOND_REPORT_ID = 'f1100000-0000-4000-8000-0000000000bb';
const THIRD_REPORT_ID = 'f1200000-0000-4000-8000-0000000000cc';
const RELEASE_ID = 'f2000000-0000-4000-8000-000000000001';
const OTHER_RELEASE_ID = 'f2000000-0000-4000-8000-000000000002';
const STAFF_ID = 'f3000000-0000-4000-8000-000000000001';
const REPORTER_ID = 'f3000000-0000-4000-8000-000000000002';
const OTHER_REPORTER_ID = 'f3000000-0000-4000-8000-000000000003';
const TRACK_ID = 'f4000000-0000-4000-8000-000000000001';

const reportRow = (overrides: Partial<Report> = {}): Report =>
  ({
    id: NAMED_REPORT_ID,
    subjectType: ReportSubjectType.StudioRelease,
    subjectId: RELEASE_ID,
    status: ReportStatus.Open,
    reporterId: REPORTER_ID,
    createdAt: new Date('2026-10-12T09:00:00.000Z'),
    resolvedAt: null,
    resolutionActorId: null,
    resolutionAction: null,
    resolutionDuration: null,
    resolutionNote: null,
    resolutionNotified: null,
    ...overrides,
  }) as Report;

type WhereMock = jest.Mock<
  OpenReportsQueryMock,
  [predicate: string, parameters?: Record<string, unknown>]
>;

interface OpenReportsQueryMock {
  setLock: jest.Mock;
  where: WhereMock;
  andWhere: WhereMock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  getMany: jest.Mock;
}

function openReportsQueryMock(rows: Report[]): OpenReportsQueryMock {
  const queryBuilder = {} as OpenReportsQueryMock;
  for (const method of [
    'setLock',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
  ] as const) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

describe('StudioTakedownReportService', () => {
  let namedReport: Report | null;
  let openReports: Report[];
  let openReportsQuery: OpenReportsQueryMock;
  let manager: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    save: jest.Mock;
    exists: jest.Mock;
  };
  let notifications: { create: jest.Mock };
  let service: StudioTakedownReportService;

  beforeEach(() => {
    namedReport = reportRow();
    openReports = [
      reportRow(),
      reportRow({
        id: SECOND_REPORT_ID,
        subjectId: RELEASE_ID.toUpperCase(),
        reporterId: OTHER_REPORTER_ID,
      }),
    ];
    manager = {
      findOne: jest.fn(() => Promise.resolve(namedReport)),
      createQueryBuilder: jest.fn(() => {
        openReportsQuery = openReportsQueryMock(openReports);
        return openReportsQuery;
      }),
      save: jest.fn((rows: Report[]) => Promise.resolve(rows)),
      exists: jest.fn().mockResolvedValue(true),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    service = new StudioTakedownReportService(
      notifications as unknown as NotificationsService,
    );
  });

  const resolve = (
    reportId: string | null = NAMED_REPORT_ID,
    isOwnerNoticeSent = true,
  ) =>
    service.resolveWithin(manager as unknown as EntityManager, {
      releaseId: RELEASE_ID,
      actorId: STAFF_ID,
      reason: 'Uploaded without the rights',
      reportId: reportId ?? undefined,
      isOwnerNoticeSent,
    });

  it('locks the named report, then resolves every open report about the release with the Studio takedown', async () => {
    const before = Date.now();

    const outcome = await resolve();

    expect(manager.findOne).toHaveBeenCalledWith(Report, {
      where: { id: NAMED_REPORT_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.createQueryBuilder).toHaveBeenCalledWith(Report, 'report');
    expect(openReportsQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(openReportsQuery.where).toHaveBeenCalledWith(
      STUDIO_RELEASE_REPORTS_PREDICATE,
      {
        studioReleaseSubjectType: 'studio_release',
        studioTrackSubjectType: 'studio_track',
        studioReportReleaseId: RELEASE_ID,
      },
    );
    expect(openReportsQuery.andWhere).toHaveBeenCalledWith(
      '"report"."status" IN (:...studioReportActionableStatuses)',
      { studioReportActionableStatuses: ['open', 'escalated'] },
    );
    expect(outcome.kind).toBe('resolved');
    const saved = manager.save.mock.calls[0]![0] as Report[];
    expect(saved.map((report) => report.id)).toEqual([
      NAMED_REPORT_ID,
      SECOND_REPORT_ID,
    ]);
    for (const report of saved) {
      expect(report).toEqual(
        expect.objectContaining({
          status: 'resolved',
          resolutionActorId: STAFF_ID,
          resolutionAction: 'studio_release_taken_down',
          resolutionDuration: null,
          resolutionNote: 'Uploaded without the rights',
          resolutionNotified: ['member', 'reporter'],
        }),
      );
      expect(report.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it('resolves every open report about the release when the takedown names none', async () => {
    const outcome = await resolve(null);
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: 'resolved',
      reports: expect.arrayContaining([
        expect.objectContaining({ id: NAMED_REPORT_ID }),
        expect.objectContaining({ id: SECOND_REPORT_ID }),
      ]) as unknown,
    });
  });

  it('resolves nothing and saves nothing when no report about the release is open', async () => {
    openReports = [];
    expect(await resolve(null)).toEqual({ kind: 'resolved', reports: [] });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('matches the named report to the release in any letter case', async () => {
    namedReport = reportRow({ subjectId: RELEASE_ID.toUpperCase() });
    expect((await resolve()).kind).toBe('resolved');
  });

  it('lists no reporter to tell for an anonymous report', async () => {
    openReports = [reportRow({ reporterId: null })];
    await resolve(null);
    expect(
      (manager.save.mock.calls[0]![0] as Report[])[0]!.resolutionNotified,
    ).toEqual(['member']);
  });

  it('lists member as notified only when the owners received the takedown notice', async () => {
    await resolve(null, false);
    const saved = manager.save.mock.calls[0]![0] as Report[];
    expect(saved.map((report) => report.resolutionNotified)).toEqual([
      ['reporter'],
      ['reporter'],
    ]);
  });

  it('lists nobody as notified for an anonymous report when no owner notice went out', async () => {
    openReports = [reportRow({ reporterId: null })];
    await resolve(null, false);
    expect(
      (manager.save.mock.calls[0]![0] as Report[])[0]!.resolutionNotified,
    ).toEqual([]);
  });

  it.each([
    ['a report that does not exist', null],
    [
      'a report about another subject type',
      reportRow({ subjectType: ReportSubjectType.Subprofile }),
    ],
    [
      'a report about another release',
      reportRow({ subjectId: OTHER_RELEASE_ID }),
    ],
  ])('answers a mismatch for %s and writes nothing', async (_label, row) => {
    namedReport = row;
    expect(await resolve()).toEqual({ kind: 'mismatch' });
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it.each([
    ['with no recorded action', null],
    ['by a dismissal', 'dismiss'],
  ])(
    'answers not open for a named report resolved %s and writes nothing',
    async (_label, resolutionAction) => {
      namedReport = reportRow({
        status: ReportStatus.Resolved,
        resolutionAction,
      });
      expect(await resolve()).toEqual({ kind: 'not_open' });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('resolves an escalated named report together with an escalated sibling', async () => {
    namedReport = reportRow({ status: ReportStatus.Escalated });
    openReports = [
      reportRow({ status: ReportStatus.Escalated }),
      reportRow({
        id: SECOND_REPORT_ID,
        status: ReportStatus.Escalated,
        reporterId: OTHER_REPORTER_ID,
      }),
    ];

    const outcome = await resolve();

    expect(outcome.kind).toBe('resolved');
    const saved = manager.save.mock.calls[0]![0] as Report[];
    expect(saved.map((report) => [report.id, report.status])).toEqual([
      [NAMED_REPORT_ID, 'resolved'],
      [SECOND_REPORT_ID, 'resolved'],
    ]);
    for (const report of saved) {
      expect(report.resolutionAction).toBe('studio_release_taken_down');
    }
  });

  it('treats a repeated submit as done and still resolves the other actionable reports', async () => {
    namedReport = reportRow({
      status: ReportStatus.Resolved,
      resolutionAction: 'studio_release_taken_down',
    });
    // The bulk query reads open and escalated rows only, so the named report
    // resolved by the first submit is absent here.
    openReports = [
      reportRow({
        id: SECOND_REPORT_ID,
        reporterId: OTHER_REPORTER_ID,
      }),
    ];

    // The release is already taken down, so no owner notice goes out.
    const outcome = await resolve(NAMED_REPORT_ID, false);

    expect(outcome).toEqual({
      kind: 'resolved',
      reports: [expect.objectContaining({ id: SECOND_REPORT_ID })],
    });
    expect(namedReport.resolvedAt).toBeNull();
    const saved = manager.save.mock.calls[0]![0] as Report[];
    expect(saved.map((report) => report.id)).toEqual([SECOND_REPORT_ID]);
  });

  it('answers resolved with no reports when a repeated submit finds nothing else to resolve', async () => {
    namedReport = reportRow({
      status: ReportStatus.Resolved,
      resolutionAction: 'studio_release_taken_down',
    });
    openReports = [];

    expect(await resolve(NAMED_REPORT_ID, false)).toEqual({
      kind: 'resolved',
      reports: [],
    });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('a named report resolved by an earlier takedown on a live release is not_open', async () => {
    namedReport = reportRow({
      status: ReportStatus.Resolved,
      resolutionAction: 'studio_release_taken_down',
    });

    // The release was restored since, so this takedown sends the owner notice.
    expect(await resolve(NAMED_REPORT_ID, true)).toEqual({
      kind: 'not_open',
    });
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('sends each reachable reporter one receipt and says nothing about the release', async () => {
    await service.notifyReportersBestEffort(
      [
        reportRow({ status: ReportStatus.Resolved }),
        reportRow({
          id: SECOND_REPORT_ID,
          status: ReportStatus.Resolved,
          reporterId: OTHER_REPORTER_ID,
        }),
        // The first reporter's second report about the same release.
        reportRow({ id: THIRD_REPORT_ID, status: ReportStatus.Resolved }),
      ],
      STAFF_ID,
    );

    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      REPORTER_ID,
      NotificationType.ReportResolved,
      {
        source: 'report',
        reportId: NAMED_REPORT_ID,
        reference: 'QPR-2026-F100',
        subjectType: 'studio_release',
        outcome: 'resolved',
      },
    );
    expect(notifications.create).toHaveBeenCalledWith(
      OTHER_REPORTER_ID,
      NotificationType.ReportResolved,
      expect.objectContaining({ reportId: SECOND_REPORT_ID }),
    );
  });

  it('sends nothing for an anonymous report or to the acting staff member', async () => {
    await service.notifyReportersBestEffort(
      [reportRow({ reporterId: null }), reportRow({ reporterId: STAFF_ID })],
      STAFF_ID,
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('keeps telling the other reporters when one receipt fails', async () => {
    notifications.create
      .mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValueOnce(null);
    await expect(
      service.notifyReportersBestEffort(
        [
          reportRow(),
          reportRow({ id: SECOND_REPORT_ID, reporterId: OTHER_REPORTER_ID }),
        ],
        STAFF_ID,
      ),
    ).resolves.toBeUndefined();
    expect(notifications.create).toHaveBeenCalledTimes(2);
  });

  // Studio safety and moderation: a takedown also closes the reports about
  // the release's tracks, and may start from one of them.
  describe('track reports', () => {
    it('reads the release reports and the reports about its tracks', () => {
      expect(STUDIO_RELEASE_REPORTS_PREDICATE).toContain(
        '"report"."subject_type" = :studioTrackSubjectType',
      );
      expect(STUDIO_RELEASE_REPORTS_PREDICATE).toContain(
        '"release_track"."release_id" = :studioReportReleaseId',
      );
      expect(STUDIO_RELEASE_REPORTS_PREDICATE).toContain(
        'lower("report"."subject_id") = :studioReportReleaseId',
      );
    });

    it('starts a takedown from an open report about one of the release tracks', async () => {
      namedReport = reportRow({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: TRACK_ID.toUpperCase(),
      });
      openReports = [namedReport];

      const outcome = await resolve();

      expect(manager.exists).toHaveBeenCalledWith(StudioTrack, {
        where: { id: TRACK_ID, releaseId: RELEASE_ID },
      });
      expect(outcome.kind).toBe('resolved');
      const [saved] = manager.save.mock.calls[0]![0] as Report[];
      expect(saved).toEqual(
        expect.objectContaining({
          status: ReportStatus.Resolved,
          resolutionAction: 'studio_release_taken_down',
          resolutionNote: 'Uploaded without the rights',
        }),
      );
    });

    it('answers a mismatch for a track report about another release', async () => {
      namedReport = reportRow({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: TRACK_ID,
      });
      manager.exists.mockResolvedValue(false);
      expect(await resolve()).toEqual({ kind: 'mismatch' });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers a mismatch for a track report whose id is no uuid, without a lookup', async () => {
      namedReport = reportRow({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: 'opening',
      });
      expect(await resolve()).toEqual({ kind: 'mismatch' });
      expect(manager.exists).not.toHaveBeenCalled();
    });
  });

  describe('resolveNamedTrackReportWithin', () => {
    const resolveTrackReport = (isOwnerNoticeSent = true) =>
      service.resolveNamedTrackReportWithin(
        manager as unknown as EntityManager,
        {
          trackId: TRACK_ID,
          actorId: STAFF_ID,
          reportId: NAMED_REPORT_ID,
          action: 'studio_track_marked_explicit',
          isOwnerNoticeSent,
        },
      );

    beforeEach(() => {
      namedReport = reportRow({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: TRACK_ID.toUpperCase(),
      });
    });

    it('resolves the named track report alone, with the action and no note', async () => {
      const outcome = await resolveTrackReport();

      expect(manager.findOne).toHaveBeenCalledWith(Report, {
        where: { id: NAMED_REPORT_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(outcome.kind).toBe('resolved');
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: NAMED_REPORT_ID,
          status: ReportStatus.Resolved,
          resolutionActorId: STAFF_ID,
          resolutionAction: 'studio_track_marked_explicit',
          resolutionNote: null,
          resolutionDuration: null,
          resolutionNotified: ['member', 'reporter'],
        }),
      );
    });

    it('lists the member as notified only when owners heard', async () => {
      await resolveTrackReport(false);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ resolutionNotified: ['reporter'] }),
      );
    });

    it('lists no reporter when the acting staff member filed it', async () => {
      namedReport = reportRow({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: TRACK_ID,
        reporterId: STAFF_ID,
      });
      await resolveTrackReport();
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ resolutionNotified: ['member'] }),
      );
    });

    it.each([
      ['a report that does not exist', null],
      ['a release report', reportRow()],
      [
        'a report about another track',
        reportRow({
          subjectType: ReportSubjectType.StudioTrack,
          subjectId: 'f4000000-0000-4000-8000-000000000002',
        }),
      ],
    ])('answers a mismatch for %s and writes nothing', async (_label, row) => {
      namedReport = row;
      expect(await resolveTrackReport()).toEqual({ kind: 'mismatch' });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers not open for a resolved report and writes nothing', async () => {
      namedReport = reportRow({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: TRACK_ID,
        status: ReportStatus.Resolved,
        resolutionAction: 'studio_track_marked_explicit',
      });
      expect(await resolveTrackReport()).toEqual({ kind: 'not_open' });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('resolves an escalated report like an open one', async () => {
      namedReport = reportRow({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: TRACK_ID,
        status: ReportStatus.Escalated,
      });
      expect((await resolveTrackReport()).kind).toBe('resolved');
    });
  });
});
