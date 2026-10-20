import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { StudioTakedownReportService } from '../moderation/studio-takedown-report.service';
import { Report } from '../reports/entities/report.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioAdminTracksService } from './studio-admin-tracks.service';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioAdminReleaseSummary } from './studio-dispute-response';
import { StudioSafetyNoticesService } from './studio-safety-notices.service';

const STAFF_ID = 'cf000000-0000-4000-8000-000000000001';
const TRACK_ID = 'cf100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'cf200000-0000-4000-8000-000000000001';
const REPORT_ID = 'cf300000-0000-4000-8000-000000000001';

const codeOf = async (
  pending: Promise<unknown>,
): Promise<string | undefined> => {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
};

describe('StudioAdminTracksService', () => {
  let trackRow: Partial<StudioTrack> | null;
  let manager: { findOne: jest.Mock; save: jest.Mock };
  let tracks: { findOne: jest.Mock };
  let catalog: { staffSummariesByReleaseId: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let takedownReports: {
    resolveNamedTrackReportWithin: jest.Mock;
    notifyReportersBestEffort: jest.Mock;
  };
  let notices: { trackMarked: jest.Mock };
  let noticesInsideTransaction: number;
  let service: StudioAdminTracksService;

  beforeEach(() => {
    trackRow = {
      id: TRACK_ID,
      releaseId: RELEASE_ID,
      position: 1,
      title: 'Opening',
      audioKey: 'studio-audio/a/b.mp3',
      durationSeconds: 200,
      isExplicit: false,
      explicitLockedAt: null,
      contentWarnings: ['police'],
      staffContentWarnings: [],
      withheldAt: null,
    };
    manager = {
      findOne: jest.fn(() => Promise.resolve(trackRow && { ...trackRow })),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    tracks = {
      findOne: jest.fn(() => Promise.resolve(trackRow && { ...trackRow })),
    };
    catalog = {
      staffSummariesByReleaseId: jest.fn(() =>
        Promise.resolve(
          new Map([
            [
              RELEASE_ID,
              {
                id: RELEASE_ID,
                title: 'Lisbon at four',
              } as StudioAdminReleaseSummary,
            ],
          ]),
        ),
      ),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
    takedownReports = {
      resolveNamedTrackReportWithin: jest.fn().mockResolvedValue({
        kind: 'resolved',
        report: { id: REPORT_ID } as Report,
      }),
      notifyReportersBestEffort: jest.fn().mockResolvedValue(undefined),
    };
    notices = { trackMarked: jest.fn().mockResolvedValue(undefined) };
    noticesInsideTransaction = 0;
    const dataSource = {
      transaction: jest.fn(
        async (work: (inner: EntityManager) => Promise<unknown>) => {
          const result = await work(manager as unknown as EntityManager);
          noticesInsideTransaction +=
            notices.trackMarked.mock.calls.length +
            takedownReports.notifyReportersBestEffort.mock.calls.length;
          return result;
        },
      ),
    };
    service = new StudioAdminTracksService(
      dataSource as unknown as DataSource,
      tracks as unknown as Repository<StudioTrack>,
      catalog as unknown as StudioCatalogService,
      modAudit as unknown as ModAuditService,
      takedownReports as unknown as StudioTakedownReportService,
      notices as unknown as StudioSafetyNoticesService,
    );
  });

  it('reads any track for staff with its release card', async () => {
    const adminTrack = await service.getTrack(TRACK_ID);
    expect(adminTrack).toEqual(
      expect.objectContaining({
        id: TRACK_ID,
        contentWarnings: ['police'],
        artistContentWarnings: ['police'],
        staffContentWarnings: [],
        isExplicitLocked: false,
        release: { id: RELEASE_ID, title: 'Lisbon at four' },
      }),
    );
    trackRow = null;
    await expect(service.getTrack(TRACK_ID)).rejects.toThrow(
      new NotFoundException('Track not found'),
    );
  });

  describe('markExplicit', () => {
    it('locks the track, marks it explicit, audits with no member and tells the owners after commit', async () => {
      await service.markExplicit(STAFF_ID, TRACK_ID);

      expect(manager.findOne).toHaveBeenCalledWith(StudioTrack, {
        where: { id: TRACK_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isExplicit: true,
          explicitLockedAt: expect.any(Date),
        }),
      );
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'studio_track_marked_explicit',
        undefined,
        `track ${TRACK_ID}`,
        undefined,
        manager,
        null,
      );
      expect(notices.trackMarked).toHaveBeenCalledWith(TRACK_ID, 'explicit');
      expect(noticesInsideTransaction).toBe(0);
      expect(
        takedownReports.resolveNamedTrackReportWithin,
      ).not.toHaveBeenCalled();
    });

    it('keeps the first lock stamp and writes no audit row and sends no notice when nothing changed', async () => {
      const firstStamp = new Date('2026-10-14T10:00:00.000Z');
      trackRow = {
        ...trackRow,
        isExplicit: true,
        explicitLockedAt: firstStamp,
      };

      await service.markExplicit(STAFF_ID, TRACK_ID);

      expect(manager.save).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(notices.trackMarked).not.toHaveBeenCalled();
    });

    it('resolves the named report with the action and sends its receipt after commit', async () => {
      await service.markExplicit(STAFF_ID, TRACK_ID, REPORT_ID);

      expect(
        takedownReports.resolveNamedTrackReportWithin,
      ).toHaveBeenCalledWith(manager, {
        trackId: TRACK_ID,
        actorId: STAFF_ID,
        reportId: REPORT_ID,
        action: 'studio_track_marked_explicit',
        isOwnerNoticeSent: true,
      });
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        REPORT_ID,
        STAFF_ID,
        'studio_track_marked_explicit',
        undefined,
        `track ${TRACK_ID}`,
        undefined,
        manager,
        null,
      );
      expect(takedownReports.notifyReportersBestEffort).toHaveBeenCalledWith(
        [{ id: REPORT_ID }],
        STAFF_ID,
      );
      expect(noticesInsideTransaction).toBe(0);
    });

    it.each([
      ['mismatch', 'studio_track_report_mismatch'],
      ['not_open', 'studio_track_report_not_open'],
    ])('refuses a %s report and changes nothing', async (kind, code) => {
      takedownReports.resolveNamedTrackReportWithin.mockResolvedValue({ kind });
      expect(
        await codeOf(service.markExplicit(STAFF_ID, TRACK_ID, REPORT_ID)),
      ).toBe(code);
      expect(manager.save).not.toHaveBeenCalled();
      expect(notices.trackMarked).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown track before reading any report', async () => {
      trackRow = null;
      await expect(
        service.markExplicit(STAFF_ID, TRACK_ID, REPORT_ID),
      ).rejects.toThrow(new NotFoundException('Track not found'));
      expect(
        takedownReports.resolveNamedTrackReportWithin,
      ).not.toHaveBeenCalled();
    });
  });

  describe('addContentWarnings', () => {
    it('adds warnings to the staff list in theme order and audits the ones added', async () => {
      trackRow = { ...trackRow, staffContentWarnings: ['self-harm'] };

      await service.addContentWarnings(STAFF_ID, TRACK_ID, [
        'police',
        'medical',
        'self-harm',
      ]);

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          staffContentWarnings: ['medical', 'self-harm', 'police'],
          contentWarnings: ['police'],
        }),
      );
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'studio_track_warning_added',
        undefined,
        `track ${TRACK_ID}: medical, police`,
        undefined,
        manager,
        null,
      );
      expect(notices.trackMarked).toHaveBeenCalledWith(
        TRACK_ID,
        'content_warning',
      );
    });

    it('writes no audit row and sends no notice when nothing changed', async () => {
      trackRow = { ...trackRow, staffContentWarnings: ['police'] };

      await service.addContentWarnings(
        STAFF_ID,
        TRACK_ID,
        ['police'],
        REPORT_ID,
      );

      expect(manager.save).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(notices.trackMarked).not.toHaveBeenCalled();
      expect(
        takedownReports.resolveNamedTrackReportWithin,
      ).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          action: 'studio_track_warning_added',
          isOwnerNoticeSent: false,
        }),
      );
    });
  });
});
