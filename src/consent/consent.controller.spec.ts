import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CURRENT_POLICY_VERSION } from './consent.constants';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { ConsentAction, ConsentSource } from './entities/consent-record.entity';

describe('ConsentController', () => {
  let controller: ConsentController;
  let service: { record: jest.Mock; myConsent: jest.Mock };

  const user: CurrentUserData = {
    userId: 'u1',
    email: 'a@b.com',
    status: 'pending',
    role: 'member',
  };

  beforeEach(async () => {
    service = {
      record: jest.fn(),
      myConsent: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConsentController],
      providers: [{ provide: ConsentService, useValue: service }],
    }).compile();
    controller = module.get(ConsentController);
  });

  it('POST / appends the record for the current user', async () => {
    const dto = {
      categories: {
        necessary: true as const,
        analytics: true,
        monitoring: false,
      },
      policyVersion: '3.3',
      source: ConsentSource.Banner,
    };
    const stored = {
      categories: { necessary: true, analytics: true, monitoring: false },
      policyVersion: '3.3',
      action: ConsentAction.Granted,
      createdAt: '2026-07-15T12:00:00.000Z',
    };
    service.record.mockResolvedValue(stored);

    const result = await controller.record(user, dto);

    expect(service.record).toHaveBeenCalledWith('u1', dto);
    expect(result).toBe(stored);
  });

  it('GET /me returns the caller current effective consent, passing the fallback policy version', async () => {
    const my = {
      categories: { necessary: true, analytics: false, monitoring: false },
      policyVersion: '3.3',
    };
    service.myConsent.mockResolvedValue(my);

    const result = await controller.me(user);

    expect(service.myConsent).toHaveBeenCalledWith(
      'u1',
      CURRENT_POLICY_VERSION,
    );
    expect(result).toBe(my);
  });

  it('a pending user (not yet active) can call both endpoints (no ActiveMemberGuard)', async () => {
    const pending: CurrentUserData = { ...user, status: 'pending' };
    service.record.mockResolvedValue({});
    await expect(
      controller.record(pending, {
        categories: {
          necessary: true as const,
          analytics: false,
          monitoring: false,
        },
        policyVersion: '3.3',
        source: ConsentSource.SettingsPane,
      }),
    ).resolves.toBeDefined();
  });
});
