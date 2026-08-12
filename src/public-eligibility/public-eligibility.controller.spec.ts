import { Test } from '@nestjs/testing';
import { PublicEligibilityController } from './public-eligibility.controller';
import { PublicEligibilityService } from './public-eligibility.service';
import { UserStatus } from '../users/entities/user.entity';

describe('PublicEligibilityController', () => {
  it('returns the signals for the current user', async () => {
    const dto = { verified: true } as any;
    const service = { getSignals: jest.fn(async () => dto) };
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicEligibilityController],
      providers: [{ provide: PublicEligibilityService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(PublicEligibilityController);
    const user = {
      userId: 'u1',
      email: 'a@b.c',
      status: UserStatus.Active,
      role: 'member',
    } as any;
    await expect(controller.getSignals(user)).resolves.toBe(dto);
    expect(service.getSignals).toHaveBeenCalledWith(user);
  });
});
