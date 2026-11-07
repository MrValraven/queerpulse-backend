import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, seconds } from '@nestjs/throttler';
import { ReportSubjectType } from './entities/report.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

const CLIENT_IP = '203.0.113.9';

describe('ReportsController', () => {
  let controller: ReportsController;
  let service: { create: jest.Mock; reasonsFor: jest.Mock };

  beforeEach(async () => {
    service = { create: jest.fn(), reasonsFor: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      // `ReportFilingThrottlerGuard` on `create` resolves the throttler options
      // and storage, which the real app gets from the global ThrottlerModule.
      imports: [ThrottlerModule.forRoot([{ limit: 10, ttl: seconds(60) }])],
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
      CLIENT_IP,
    );

    expect(service.create).toHaveBeenCalledWith(
      'user-1',
      {
        subjectType: ReportSubjectType.Member,
        subjectId: 'user-2',
        reasonCode: 'harassment',
      },
      CLIENT_IP,
    );
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
      CLIENT_IP,
    );

    expect(service.create).toHaveBeenCalledWith(
      'user-1',
      {
        subjectType: ReportSubjectType.Post,
        subjectId: 'post-1',
        reasonCode: 'doxxing',
        detail: 'Shared my address in a reply.',
        anonymous: true,
        contactEmail: 'reporter@example.com',
        evidence: [{ type: 'url', value: 'https://example.com/proof' }],
      },
      CLIENT_IP,
    );
  });

  // PRD-280: the route is public, so `OptionalJwtAuthGuard` hands the handler
  // `undefined` rather than a principal. The service is then told there is no
  // reporter, which is what selects the anonymous flood caps and the
  // contact-email rule inside it.
  it('files with a null reporter when the caller is signed out', async () => {
    service.create.mockResolvedValue({ id: 'report-3' });
    await controller.create(
      undefined,
      {
        subjectType: ReportSubjectType.Member,
        subjectId: 'user-2',
        reasonCode: 'harassment',
        contactEmail: 'stranger@example.com',
      },
      CLIENT_IP,
    );

    expect(service.create).toHaveBeenCalledWith(
      null,
      {
        subjectType: ReportSubjectType.Member,
        subjectId: 'user-2',
        reasonCode: 'harassment',
        contactEmail: 'stranger@example.com',
      },
      CLIENT_IP,
    );
  });

  // `@Public()` makes the class-level `ActiveMemberGuard` step aside, so the
  // active-member rule is re-stated in the handler for a caller who IS signed
  // in. A suspended account must not file under its own id.
  it('refuses a signed-in caller who is not an active member', async () => {
    expect(() =>
      controller.create(
        {
          userId: 'user-1',
          email: 'a@b.com',
          status: 'suspended',
          role: 'member',
        },
        {
          subjectType: ReportSubjectType.Member,
          subjectId: 'user-2',
          reasonCode: 'harassment',
        },
        CLIENT_IP,
      ),
    ).toThrow(ForbiddenException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('names the ACTIVE_MEMBERSHIP_REQUIRED code on that refusal', () => {
    let refusal: ForbiddenException | undefined;
    try {
      void controller.create(
        {
          userId: 'user-1',
          email: 'a@b.com',
          status: 'suspended',
          role: 'member',
        },
        {
          subjectType: ReportSubjectType.Member,
          subjectId: 'user-2',
          reasonCode: 'harassment',
        },
        CLIENT_IP,
      );
    } catch (error) {
      refusal = error as ForbiddenException;
    }
    expect(refusal?.getResponse()).toEqual({
      code: 'ACTIVE_MEMBERSHIP_REQUIRED',
      message: 'Active membership required',
    });
  });

  it('delegates the reason catalogue to the service', () => {
    controller.reasons({ subjectType: ReportSubjectType.Venue });
    expect(service.reasonsFor).toHaveBeenCalledWith(ReportSubjectType.Venue);
  });
});
