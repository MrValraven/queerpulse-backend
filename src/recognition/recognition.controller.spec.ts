import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import {
  MemberRecognitionController,
  MyRecognitionController,
} from './recognition.controller';
import { RecognitionService } from './recognition.service';

describe('MyRecognitionController', () => {
  let controller: MyRecognitionController;
  let service: { getForUser: jest.Mock; getBySlug: jest.Mock };

  const user: CurrentUserData = {
    userId: 'u1',
    email: 'a@b.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = { getForUser: jest.fn(), getBySlug: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MyRecognitionController],
      providers: [{ provide: RecognitionService, useValue: service }],
    }).compile();
    controller = module.get(MyRecognitionController);
  });

  it('GET /me/recognition delegates to getForUser with the caller id', async () => {
    const dto = { level: { level: 1 } };
    service.getForUser.mockResolvedValue(dto);

    const result = await controller.getMine(user);

    expect(service.getForUser).toHaveBeenCalledWith('u1', true);
    expect(result).toBe(dto);
  });
});

describe('MemberRecognitionController', () => {
  let controller: MemberRecognitionController;
  let service: { getForUser: jest.Mock; getBySlug: jest.Mock };

  beforeEach(async () => {
    service = { getForUser: jest.fn(), getBySlug: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemberRecognitionController],
      providers: [{ provide: RecognitionService, useValue: service }],
    }).compile();
    controller = module.get(MemberRecognitionController);
  });

  it('GET /profiles/:slug/recognition delegates to getBySlug with the path param', async () => {
    const dto = { level: { level: 3 } };
    service.getBySlug.mockResolvedValue(dto);

    const result = await controller.getForMember('jamie');

    expect(service.getBySlug).toHaveBeenCalledWith('jamie');
    expect(result).toBe(dto);
  });
});
