import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateListingDto } from './dto/create-listing.dto';
import { ListingStatus } from './entities/listing.entity';
import { AdminListingsController } from './admin-listings.controller';
import { ListingClaimsService } from './listing-claims.service';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { ListingOwnerPendingService } from './listing-owner-pending.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

describe('ListingsController', () => {
  let controller: ListingsController;
  // The moderator/admin routes moved to their own controller (BE-HSG-29); the
  // four tests below drive it through the same mocked service.
  let adminController: AdminListingsController;
  let service: {
    create: jest.Mock;
    listMine: jest.Mock;
    getByRef: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    setStatus: jest.Mock;
    replyToReview: jest.Mock;
    bulkSetStatus: jest.Mock;
    bulkRemove: jest.Mock;
    getListingHistory: jest.Mock;
    getOwnerListingHistory: jest.Mock;
    answerQuestion: jest.Mock;
    answerPublicQuestion: jest.Mock;
    answerPublicQuestionAsModerator: jest.Mock;
  };
  let ownerPendingService: { getPendingForOwner: jest.Mock };

  const user: CurrentUserData = {
    userId: 'owner-1',
    email: 'a@b.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      listMine: jest.fn(),
      getByRef: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      setStatus: jest.fn(),
      replyToReview: jest.fn(),
      bulkSetStatus: jest.fn(),
      bulkRemove: jest.fn(),
      getListingHistory: jest.fn(),
      getOwnerListingHistory: jest.fn(),
      answerQuestion: jest.fn(),
      answerPublicQuestion: jest.fn(),
      answerPublicQuestionAsModerator: jest.fn(),
    };
    ownerPendingService = { getPendingForOwner: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ListingsController, AdminListingsController],
      providers: [
        { provide: ListingsService, useValue: service },
        { provide: ListingEditSuggestionsService, useValue: {} },
        { provide: ListingClaimsService, useValue: {} },
        {
          provide: ListingOwnerPendingService,
          useValue: ownerPendingService,
        },
      ],
    })
      .overrideGuard(ActiveMemberGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(ListingsController);
    adminController = module.get(AdminListingsController);
  });

  it('GET /:ref/history passes the caller and page to the owner history read', async () => {
    const history = {
      events: [],
      questions: [],
      totalEvents: 0,
      page: 2,
      pageSize: 20,
    };
    service.getOwnerListingHistory.mockResolvedValue(history);

    const result = await controller.getOwnHistory(user, 'QPL-2026-0001', {
      page: 2,
    });

    expect(service.getOwnerListingHistory).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'owner-1',
      2,
    );
    expect(result).toBe(history);
  });

  it('GET /:ref/pending scopes the pending read to the caller as owner', async () => {
    const pending = {
      counts: {
        editSuggestions: 0,
        ownershipClaims: 0,
        disputes: 0,
        unansweredQuestions: 0,
        total: 0,
      },
      editSuggestions: [],
      ownershipClaims: [],
      disputes: [],
      unansweredQuestions: [],
    };
    ownerPendingService.getPendingForOwner.mockResolvedValue(pending);

    const result = await controller.getOwnPending(user, 'QPL-2026-0001');

    expect(ownerPendingService.getPendingForOwner).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'owner-1',
    );
    expect(result).toBe(pending);
  });

  it('POST / creates a listing owned by the caller', async () => {
    const dto = { name: 'Lux Café' } as CreateListingDto;
    const created = { ref: 'QPL-2026-0001', ...dto };
    service.create.mockResolvedValue(created);

    const result = await controller.create(user, dto);

    expect(service.create).toHaveBeenCalledWith('owner-1', dto);
    expect(result).toBe(created);
  });

  it('GET /mine lists the caller listings for the given page', async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    service.listMine.mockResolvedValue(page);

    const result = await controller.listMine(user, { page: 1 });

    expect(service.listMine).toHaveBeenCalledWith('owner-1', { page: 1 });
    expect(result).toBe(page);
  });

  it('GET /:ref fetches by ref for the caller', async () => {
    const dto = { ref: 'QPL-2026-0001' };
    service.getByRef.mockResolvedValue(dto);

    const result = await controller.get(user, 'QPL-2026-0001');

    expect(service.getByRef).toHaveBeenCalledWith('QPL-2026-0001', 'owner-1');
    expect(result).toBe(dto);
  });

  it('PATCH /:ref updates by ref for the caller', async () => {
    const patch = { blurb: 'new' };
    const updated = { ref: 'QPL-2026-0001', blurb: 'new' };
    service.update.mockResolvedValue(updated);

    const result = await controller.update(user, 'QPL-2026-0001', patch);

    expect(service.update).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'owner-1',
      patch,
    );
    expect(result).toBe(updated);
  });

  it('DELETE /:ref removes by ref for the caller', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove(user, 'QPL-2026-0001');

    expect(service.remove).toHaveBeenCalledWith('QPL-2026-0001', 'owner-1');
  });

  it('PATCH /admin/listings/:ref/status forwards the status transition and the acting moderator', async () => {
    const updated = { ref: 'QPL-2026-0001', status: ListingStatus.Live };
    service.setStatus.mockResolvedValue(updated);

    const result = await adminController.setStatus(user, 'QPL-2026-0001', {
      status: ListingStatus.Live,
    });

    expect(service.setStatus).toHaveBeenCalledWith(
      'QPL-2026-0001',
      ListingStatus.Live,
      'owner-1',
      undefined,
    );
    expect(result).toBe(updated);
  });

  it('PATCH /admin/listings/bulk-status forwards refs/status/actor/reason', async () => {
    const summary = { updated: ['QPL-2026-0001'], failed: [] };
    service.bulkSetStatus.mockResolvedValue(summary);

    const result = await adminController.bulkSetStatus(user, {
      refs: ['QPL-2026-0001'],
      status: ListingStatus.Live,
      reason: 'looks good',
    });

    expect(service.bulkSetStatus).toHaveBeenCalledWith(
      ['QPL-2026-0001'],
      ListingStatus.Live,
      'owner-1',
      'looks good',
    );
    expect(result).toBe(summary);
  });

  it('POST /admin/listings/bulk-remove forwards refs/actor/reason', async () => {
    const summary = { updated: ['QPL-2026-0001'], failed: ['QPL-2026-9999'] };
    service.bulkRemove.mockResolvedValue(summary);

    const result = await adminController.bulkRemove(user, {
      refs: ['QPL-2026-0001', 'QPL-2026-9999'],
    });

    expect(service.bulkRemove).toHaveBeenCalledWith(
      ['QPL-2026-0001', 'QPL-2026-9999'],
      'owner-1',
      undefined,
    );
    expect(result).toBe(summary);
  });

  it('GET /admin/listings/:ref/history forwards the ref', async () => {
    const history = { events: [], questions: [] };
    service.getListingHistory.mockResolvedValue(history);

    const result = await adminController.getHistory('QPL-2026-0001');

    expect(service.getListingHistory).toHaveBeenCalledWith('QPL-2026-0001');
    expect(result).toBe(history);
  });

  it('POST :ref/questions/:id/answer forwards to the service for the caller', async () => {
    const answered = { id: 'question-1', answer: 'Sure, opens at 9am.' };
    service.answerQuestion.mockResolvedValue(answered);

    const result = await controller.answerQuestion(
      user,
      'QPL-2026-0001',
      'question-1',
      { answer: 'Sure, opens at 9am.' },
    );

    expect(service.answerQuestion).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'question-1',
      'owner-1',
      'Sure, opens at 9am.',
    );
    expect(result).toBe(answered);
  });

  it('PATCH /:ref/reviews/:reviewId/reply forwards to the service for the caller', async () => {
    const updated = { text: 'Thanks!' };
    service.replyToReview.mockResolvedValue(updated);

    const result = await controller.replyToReview(
      user,
      'QPL-2026-0001',
      'review-1',
      { text: 'Thanks!' },
    );

    expect(service.replyToReview).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'owner-1',
      'review-1',
      { text: 'Thanks!' },
    );
    expect(result).toBe(updated);
  });

  // The public Q&A answer routes. The point of these two is the SPLIT: the
  // owner route and the moderator route must reach different service methods,
  // because only one of them is allowed to speak as the business.
  it('POST /:ref/public-questions/:id/answer routes the OWNER answer', async () => {
    service.answerPublicQuestion.mockResolvedValue({ id: 'question-1' });

    await controller.answerPublicQuestion(user, 'QPL-2026-0001', 'question-1', {
      answer: 'Yes, the entrance is step-free.',
    });

    expect(service.answerPublicQuestion).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'question-1',
      'owner-1',
      'Yes, the entrance is step-free.',
    );
    // Never the moderator path — that one stamps the answer as staff-written.
    expect(service.answerPublicQuestionAsModerator).not.toHaveBeenCalled();
  });

  it('POST /admin/listings/:ref/public-questions/:id/answer routes the MODERATOR answer', async () => {
    service.answerPublicQuestionAsModerator.mockResolvedValue({
      id: 'question-1',
    });

    await adminController.answerPublicQuestion(
      user,
      'QPL-2026-0001',
      'question-1',
      { answer: 'We have asked the venue and will update this.' },
    );

    expect(service.answerPublicQuestionAsModerator).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'question-1',
      'owner-1',
      'We have asked the venue and will update this.',
    );
    expect(service.answerPublicQuestion).not.toHaveBeenCalled();
  });
});
