import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MagazineController } from './magazine.controller';
import { MagazineReaderCommentsService } from './magazine-reader-comments.service';
import { MagazineService } from './magazine.service';
import { StorySubmissionsService } from './story-submissions.service';

const user: CurrentUserData = {
  userId: 'user-1',
  email: 'a@example.com',
  status: 'active',
  role: 'member',
};

describe('MagazineController reader comments', () => {
  let controller: MagazineController;
  let readerComments: {
    list: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    readerComments = {
      list: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({}),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MagazineController],
      providers: [
        { provide: MagazineService, useValue: {} },
        { provide: StorySubmissionsService, useValue: {} },
        { provide: MagazineReaderCommentsService, useValue: readerComments },
      ],
    }).compile();
    controller = module.get(MagazineController);
  });

  it('listComments delegates slug/user/page', async () => {
    await controller.listComments(user, 'city-changed', { page: 2 });
    expect(readerComments.list).toHaveBeenCalledWith('city-changed', user, 2);
  });

  it('createComment delegates slug/user/body/parentId', async () => {
    await controller.createComment(user, 'city-changed', {
      body: 'hi',
      parentId: 'top-1',
    });
    expect(readerComments.create).toHaveBeenCalledWith(
      'city-changed',
      user,
      'hi',
      'top-1',
    );
  });

  it('updateComment delegates id/user/body', async () => {
    await controller.updateComment(user, 'c1', { body: 'edited' });
    expect(readerComments.update).toHaveBeenCalledWith('c1', user, 'edited');
  });

  it('deleteComment delegates id/user', async () => {
    await controller.deleteComment(user, 'c1');
    expect(readerComments.remove).toHaveBeenCalledWith('c1', user);
  });
});
