import { Test } from '@nestjs/testing';
import { PublicEligibilityController } from './public-eligibility.controller';
import { PublicEligibilityService } from './public-eligibility.service';
import { UserStatus } from '../users/entities/user.entity';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import type { PublicEligibilitySignalsDto } from './public-eligibility-response';

describe('PublicEligibilityController', () => {
  it('returns the signals for the current user', async () => {
    // Only the field this test asserts on: the mock stands in for
    // `PublicEligibilityService` via Nest's untyped `useValue`, so it need
    // not carry the full `PublicEligibilitySignalsDto` shape.
    const dto: Pick<PublicEligibilitySignalsDto, 'verified'> = {
      verified: true,
    };
    const service = { getSignals: jest.fn(async () => dto) };
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicEligibilityController],
      providers: [{ provide: PublicEligibilityService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(PublicEligibilityController);
    const user: CurrentUserData = {
      userId: 'u1',
      email: 'a@b.c',
      status: UserStatus.Active,
      role: 'member',
    };
    await expect(controller.getSignals(user)).resolves.toBe(dto);
    expect(service.getSignals).toHaveBeenCalledWith(user);
  });
});
