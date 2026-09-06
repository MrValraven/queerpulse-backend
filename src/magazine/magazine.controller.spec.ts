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

/**
 * PRD-106 — `GET /magazine/issues/open`. The route must be DECLARED before
 * `issues/:number`, since Nest matches in declaration order and "open" would
 * otherwise be swallowed as an issue number and 404.
 */
describe('MagazineController open issue', () => {
  let controller: MagazineController;
  let magazine: { getOpenIssue: jest.Mock; getIssueByNumber: jest.Mock };

  beforeEach(async () => {
    magazine = {
      getOpenIssue: jest.fn().mockResolvedValue(null),
      getIssueByNumber: jest.fn().mockResolvedValue({}),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MagazineController],
      providers: [
        { provide: MagazineService, useValue: magazine },
        { provide: StorySubmissionsService, useValue: {} },
        { provide: MagazineReaderCommentsService, useValue: {} },
      ],
    }).compile();
    controller = module.get(MagazineController);
  });

  it('delegates to the service', async () => {
    await controller.getOpenIssue();
    expect(magazine.getOpenIssue).toHaveBeenCalledWith();
  });

  it('answers null when nothing is open, without 404ing', async () => {
    await expect(controller.getOpenIssue()).resolves.toBeNull();
  });

  it('declares the literal route before the :number wildcard', () => {
    const handlerNames = Object.getOwnPropertyNames(
      MagazineController.prototype,
    );
    expect(handlerNames.indexOf('getOpenIssue')).toBeLessThan(
      handlerNames.indexOf('getIssue'),
    );
  });
});

/**
 * PRD-129 — `POST /magazine/submissions/:id/withdraw`. This is a MEMBER route
 * (`ActiveMemberGuard` alone, like the rest of this controller): a story
 * submission belongs to a plain member, and `magazine_pitch` on the
 * writer-workspace controller is a different resource in a different id space
 * that a member never has.
 */
describe('MagazineController withdraw submission', () => {
  let controller: MagazineController;
  let storySubmissions: { withdrawMine: jest.Mock };

  beforeEach(async () => {
    storySubmissions = { withdrawMine: jest.fn().mockResolvedValue({}) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MagazineController],
      providers: [
        { provide: MagazineService, useValue: {} },
        { provide: StorySubmissionsService, useValue: storySubmissions },
        { provide: MagazineReaderCommentsService, useValue: {} },
      ],
    }).compile();
    controller = module.get(MagazineController);
  });

  // SECURITY: the owner comes from the session, never from the request. A
  // client-supplied user id here would let anyone withdraw anyone's story.
  it("passes the session's own user id, never a client-supplied one", async () => {
    await controller.withdrawMySubmission('sub-1', user);
    expect(storySubmissions.withdrawMine).toHaveBeenCalledWith(
      'user-1',
      'sub-1',
    );
  });
});
