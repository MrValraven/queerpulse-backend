import { Test, TestingModule } from '@nestjs/testing';
import { ReportSubjectType } from './entities/report.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

describe('ReportsController', () => {
  let controller: ReportsController;
  let service: { create: jest.Mock; reasonsFor: jest.Mock };

  beforeEach(async () => {
    service = { create: jest.fn(), reasonsFor: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [{ provide: ReportsService, useValue: service }],
    }).compile();
    controller = module.get(ReportsController);
  });

  it('creates a report scoped to the current user', async () => {
    service.create.mockResolvedValue({ id: 'report-1' });
    await controller.create(
      { userId: 'user-1', email: 'a@b.com', status: 'active', role: 'member' },
      {
        subjectType: ReportSubjectType.Member,
        subjectId: 'user-2',
        reasonCode: 'harassment',
      },
    );

    expect(service.create).toHaveBeenCalledWith('user-1', {
      subjectType: ReportSubjectType.Member,
      subjectId: 'user-2',
      reasonCode: 'harassment',
    });
  });

  it('creates an anonymous report with evidence and a contact email', async () => {
    service.create.mockResolvedValue({ id: 'report-2' });
    await controller.create(
      { userId: 'user-1', email: 'a@b.com', status: 'active', role: 'member' },
      {
        subjectType: ReportSubjectType.Post,
        subjectId: 'post-1',
        reasonCode: 'doxxing',
        detail: 'Shared my address in a reply.',
        anonymous: true,
        contactEmail: 'reporter@example.com',
        evidence: [{ type: 'url', value: 'https://example.com/proof' }],
      },
    );

    expect(service.create).toHaveBeenCalledWith('user-1', {
      subjectType: ReportSubjectType.Post,
      subjectId: 'post-1',
      reasonCode: 'doxxing',
      detail: 'Shared my address in a reply.',
      anonymous: true,
      contactEmail: 'reporter@example.com',
      evidence: [{ type: 'url', value: 'https://example.com/proof' }],
    });
  });

  it('delegates the reason catalogue to the service', () => {
    controller.reasons({ subjectType: ReportSubjectType.Venue });
    expect(service.reasonsFor).toHaveBeenCalledWith(ReportSubjectType.Venue);
  });
});
