import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  let service: ReportsService;
  let reports: {
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    reports = {
      create: jest.fn((v: object) => v),
      save: jest.fn((r: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(r as object),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getRepositoryToken(Report), useValue: reports },
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
  });
});
