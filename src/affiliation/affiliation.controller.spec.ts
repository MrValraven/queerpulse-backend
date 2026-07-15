import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { AffiliationController } from './affiliation.controller';
import { AffiliationService } from './affiliation.service';

describe('AffiliationController', () => {
  let controller: AffiliationController;
  let service: {
    myAffiliation: jest.Mock;
    setAffiliation: jest.Mock;
    removeAffiliation: jest.Mock;
  };

  const user: CurrentUserData = {
    userId: 'u1',
    email: 'a@b.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = {
      myAffiliation: jest.fn(),
      setAffiliation: jest.fn(),
      removeAffiliation: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AffiliationController],
      providers: [{ provide: AffiliationService, useValue: service }],
    }).compile();
    controller = module.get(AffiliationController);
  });

  it('GET / returns the caller current affiliation (or null)', async () => {
    service.myAffiliation.mockResolvedValue(null);
    const result = await controller.get(user);
    expect(service.myAffiliation).toHaveBeenCalledWith('u1');
    expect(result).toBeNull();
  });

  it('POST / sets the affiliation for the caller from the body', async () => {
    const dto = { companySlug: 'acme', role: 'Engineer' };
    const stored = {
      companySlug: 'acme',
      company: { nameText: 'Acme Co' },
      role: 'Engineer',
      status: 'pending',
    };
    service.setAffiliation.mockResolvedValue(stored);

    const result = await controller.set(user, dto);

    expect(service.setAffiliation).toHaveBeenCalledWith('u1', dto);
    expect(result).toBe(stored);
  });

  it('DELETE / removes the caller affiliation', async () => {
    service.removeAffiliation.mockResolvedValue(undefined);
    await controller.remove(user);
    expect(service.removeAffiliation).toHaveBeenCalledWith('u1');
  });
});
