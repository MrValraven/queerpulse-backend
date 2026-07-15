import { Test, TestingModule } from '@nestjs/testing';
import { ReportSeverity } from '../reports/entities/report.entity';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';

const actor = {
  userId: 'actor-1',
  email: 'mod@example.com',
  status: 'active',
  role: 'moderator',
};

describe('ModerationController', () => {
  let controller: ModerationController;
  let service: {
    list: jest.Mock;
    getById: jest.Mock;
    actOnReport: jest.Mock;
    bulkActOnReports: jest.Mock;
    auditTrail: jest.Mock;
    listAppeals: jest.Mock;
    reviewAppeal: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      actOnReport: jest.fn(),
      bulkActOnReports: jest.fn(),
      auditTrail: jest.fn(),
      listAppeals: jest.fn(),
      reviewAppeal: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ModerationController],
      providers: [{ provide: ModerationService, useValue: service }],
    }).compile();
    controller = module.get(ModerationController);
  });

  it('lists reports with the frontend query filters (tab/filter/severity/subjectType/sort/cursor)', async () => {
    const query = {
      tab: 'open' as const,
      filter: 'emergencies' as const,
      severity: ReportSeverity.High,
      sort: 'priority' as const,
    };
    await controller.listReports(query);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('reads the audit trail for a reportId', async () => {
    await controller.audit({ reportId: 'report-1' });
    expect(service.auditTrail).toHaveBeenCalledWith('report-1');
  });

  it('gets one report by id', async () => {
    await controller.getReport('report-1');
    expect(service.getById).toHaveBeenCalledWith('report-1');
  });

  it('acts on a report as the current actor', async () => {
    await controller.updateReport(actor, 'report-1', {
      action: 'remove_content',
      reasonCode: 'hate_speech',
      note: 'Removed for hate speech.',
    });
    expect(service.actOnReport).toHaveBeenCalledWith('report-1', 'actor-1', {
      action: 'remove_content',
      reasonCode: 'hate_speech',
      note: 'Removed for hate speech.',
    });
  });

  it('bulk-acts on reports as the current actor', async () => {
    await controller.bulkUpdateReports(actor, {
      ids: ['report-1', 'report-2'],
      action: 'dismiss',
      reasonCode: 'spam',
    });
    expect(service.bulkActOnReports).toHaveBeenCalledWith('actor-1', {
      ids: ['report-1', 'report-2'],
      action: 'dismiss',
      reasonCode: 'spam',
    });
  });

  it('lists appeals', async () => {
    await controller.listAppeals();
    expect(service.listAppeals).toHaveBeenCalled();
  });

  it('reviews an appeal as the current actor', async () => {
    await controller.reviewAppeal(actor, 'appeal-1', {
      decision: 'uphold',
      note: 'Evidence supports the original action.',
    });
    expect(service.reviewAppeal).toHaveBeenCalledWith('appeal-1', 'actor-1', {
      decision: 'uphold',
      note: 'Evidence supports the original action.',
    });
  });
});
