import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { HttpStatus, NotFoundException } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Event } from '../events/entities/event.entity';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SafeSpaceMemberVouch } from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import { SafeSpaceBadgeService } from '../safe-space-nominations/safe-space-badge.service';
import { DirectoryService } from './directory.service';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingReviewHelpfulVote } from './entities/listing-review-helpful-vote.entity';
import { ListingReview } from './entities/listing-review.entity';
import { Listing, ListingStatus } from './entities/listing.entity';

/**
 * Covers the three member-facing write paths added to the directory: editing
 * your own review, helpful votes, and the public question box. The read paths
 * this service has always had are exercised through the listings specs and are
 * deliberately not re-covered here.
 */
describe('DirectoryService', () => {
  let service: DirectoryService;
  let listings: { findOne: jest.Mock };
  let reviews: { findOne: jest.Mock; save: jest.Mock; find: jest.Mock };
  let helpfulVotes: Record<string, jest.Mock>;
  let publicQuestions: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock; findOne: jest.Mock };
  let contentModeration: { statesFor: jest.Mock; statesForAnyType: jest.Mock };
  let notifications: { create: jest.Mock };
  let storage: { deleteObjectByReference: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let transactionManager: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  const LIVE_LISTING = {
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'lux-cafe',
    name: 'Lux Cafe',
    ownerId: 'owner-1',
    status: ListingStatus.Live,
    isHiddenByOwner: false,
  } as unknown as Listing;

  const existingReview = (overrides: Partial<ListingReview> = {}) =>
    ({
      id: 'review-1',
      listingId: 'listing-1',
      reviewerId: 'member-1',
      reviewerName: 'Ana Silva',
      byline: 'she/her',
      stars: 2,
      text: 'The ramp was blocked.',
      photo: '',
      helpful: 0,
      ownerReplyText: null,
      ownerRepliedAt: null,
      editedAt: null,
      createdAt: new Date('2026-03-01T10:00:00.000Z'),
      ...overrides,
    }) as ListingReview;

  // The insert chain `voteHelpful` builds: `.insert().into().values()
  // .orIgnore().execute()`, every link returning the same object.
  const insertChain = () => {
    const chain: Record<string, jest.Mock> = {};
    for (const method of ['insert', 'into', 'values', 'orIgnore']) {
      chain[method] = jest.fn().mockReturnValue(chain);
    }
    chain.execute = jest.fn().mockResolvedValue({});
    return chain;
  };

  beforeEach(async () => {
    listings = { findOne: jest.fn().mockResolvedValue(LIVE_LISTING) };
    reviews = {
      findOne: jest.fn(),
      save: jest.fn((row: object) => Promise.resolve(row)),
      find: jest.fn().mockResolvedValue([]),
    };
    helpfulVotes = {};
    publicQuestions = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({
          id: 'public-question-1',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          answer: null,
          answeredAt: null,
          isAnsweredByModerator: false,
          ...row,
        }),
      ),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    contentModeration = {
      statesFor: jest.fn().mockResolvedValue(new Map()),
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
    };
    notifications = { create: jest.fn() };
    storage = { deleteObjectByReference: jest.fn() };
    transactionManager = {
      createQueryBuilder: jest.fn(() => insertChain()),
      // Backs `lockReviewRow`'s `SELECT ... FOR UPDATE`.
      findOne: jest.fn().mockResolvedValue({ id: 'review-1' }),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (manager: EntityManager) => Promise<number>) =>
          work(transactionManager as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectoryService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(ListingReview), useValue: reviews },
        {
          provide: getRepositoryToken(ListingReviewHelpfulVote),
          useValue: helpfulVotes,
        },
        {
          provide: getRepositoryToken(ListingPublicQuestion),
          useValue: publicQuestions,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Event), useValue: { find: jest.fn() } },
        {
          provide: getRepositoryToken(SavedItem),
          useValue: { count: jest.fn() },
        },
        {
          provide: getRepositoryToken(SafeSpaceMemberVouch),
          useValue: { find: jest.fn() },
        },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: StorageService, useValue: storage },
        { provide: DataSource, useValue: dataSource },
        // The batched open-suspension lookup every public card read now makes.
        // No suspensions in these fixtures, so it answers with an empty Map.
        {
          provide: SafeSpaceBadgeService,
          useValue: {
            openSuspensionsByListing: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();
    service = module.get(DirectoryService);
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('updateReview', () => {
    it('refuses to edit somebody else’s review', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({ reviewerId: 'someone-else' }),
      );

      await expect(
        service.updateReview('lux-cafe', 'review-1', 'member-1', {
          stars: 5,
          text: 'Actually lovely.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('refuses to edit a seeded review with no author at all', async () => {
      reviews.findOne.mockResolvedValue(existingReview({ reviewerId: null }));

      await expect(
        service.updateReview('lux-cafe', 'review-1', 'member-1', {
          stars: 5,
          text: 'Actually lovely.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s a review id that belongs to a different listing', async () => {
      reviews.findOne.mockResolvedValue(null);

      await expect(
        service.updateReview('lux-cafe', 'review-1', 'member-1', {
          stars: 5,
          text: 'Actually lovely.',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a whitespace-only body post-trim', async () => {
      reviews.findOne.mockResolvedValue(existingReview());

      await expect(
        service.updateReview('lux-cafe', 'review-1', 'member-1', {
          stars: 4,
          text: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('writes the new stars and stamps editedAt', async () => {
      reviews.findOne.mockResolvedValue(existingReview());

      const dto = await service.updateReview(
        'lux-cafe',
        'review-1',
        'member-1',
        { stars: 5, text: '  They fixed the ramp.  ' },
      );

      expect(dto.stars).toBe(5);
      expect(dto.text).toBe('They fixed the ramp.');
      expect(dto.editedAt).toEqual(expect.any(String) as unknown);
    });

    it('KEEPS the owner reply and flags the review as edited after it', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({
          ownerReplyText: 'Sorry about that, we have moved the crates.',
          ownerRepliedAt: new Date('2026-03-02T10:00:00.000Z'),
        }),
      );

      const dto = await service.updateReview(
        'lux-cafe',
        'review-1',
        'member-1',
        { stars: 1, text: 'Worse than I first said.' },
      );

      // Clearing the reply here would hand the reviewer a delete button for
      // the business's public response.
      expect(dto.ownerReply).not.toBeNull();
      expect(dto.ownerReply?.text).toBe(
        'Sorry about that, we have moved the crates.',
      );
      // And the ordering is now visible instead of silent.
      expect(dto.isEditedAfterOwnerReply).toBe(true);
    });

    it('does not stamp an edit when nothing actually changed', async () => {
      const review = existingReview({
        ownerReplyText: 'Thanks for the note.',
        ownerRepliedAt: new Date('2026-03-02T10:00:00.000Z'),
      });
      reviews.findOne.mockResolvedValue(review);

      const dto = await service.updateReview(
        'lux-cafe',
        'review-1',
        'member-1',
        { stars: 2, text: 'The ramp was blocked.' },
      );

      // A re-save of an identical body must not manufacture an
      // "edited after the reply" flag against the owner.
      expect(dto.editedAt).toBeNull();
      expect(dto.isEditedAfterOwnerReply).toBe(false);
    });

    it('deletes the superseded photo object when the photo is replaced', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({ photo: 'listing-photos/member-1/old.jpg' }),
      );

      await service.updateReview('lux-cafe', 'review-1', 'member-1', {
        stars: 2,
        text: 'The ramp was blocked.',
        photo: 'listing-photos/member-1/new.jpg',
      });

      expect(storage.deleteObjectByReference).toHaveBeenCalledWith(
        'listing-photos/member-1/old.jpg',
      );
    });

    it('never fails the edit because the storage delete failed', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({ photo: 'listing-photos/member-1/old.jpg' }),
      );
      storage.deleteObjectByReference.mockRejectedValue(new Error('bucket'));

      await expect(
        service.updateReview('lux-cafe', 'review-1', 'member-1', {
          stars: 2,
          text: 'The ramp was blocked.',
          photo: '',
        }),
      ).resolves.toEqual(expect.objectContaining({ photoUrl: null }));
    });
  });

  describe('voteHelpful', () => {
    it('refuses a vote on your own review', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({ reviewerId: 'member-1' }),
      );

      await expect(
        service.voteHelpful('lux-cafe', 'review-1', 'member-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('inserts with ON CONFLICT DO NOTHING so a double tap is not an error', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({ reviewerId: 'author-1' }),
      );
      const chain = insertChain();
      transactionManager.createQueryBuilder.mockReturnValue(chain);

      const first = await service.voteHelpful(
        'lux-cafe',
        'review-1',
        'member-1',
      );
      const second = await service.voteHelpful(
        'lux-cafe',
        'review-1',
        'member-1',
      );

      expect(chain.orIgnore).toHaveBeenCalled();
      // The review row is locked before the insert, so two members voting at
      // once cannot both count 1 and leave the column one short.
      expect(transactionManager.findOne).toHaveBeenCalledWith(
        ListingReview,
        expect.objectContaining({
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(first).toEqual({
        reviewId: 'review-1',
        helpful: 1,
        hasVoted: true,
      });
      // Idempotent: the second call answers with the same tally, not a 409.
      expect(second).toEqual(first);
    });

    it('RECOUNTS the denormalized column rather than incrementing it', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({ reviewerId: 'author-1', helpful: 99 }),
      );
      transactionManager.count.mockResolvedValue(4);

      const result = await service.voteHelpful(
        'lux-cafe',
        'review-1',
        'member-1',
      );

      // The stale 99 on the row is irrelevant: the tally comes from the vote
      // rows, so the column cannot drift away from what it claims to count.
      expect(result.helpful).toBe(4);
      expect(transactionManager.update).toHaveBeenCalledWith(
        ListingReview,
        { id: 'review-1' },
        { helpful: 4 },
      );
    });

    it('404s a review that does not belong to this listing', async () => {
      reviews.findOne.mockResolvedValue(null);

      await expect(
        service.voteHelpful('lux-cafe', 'review-1', 'member-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('withdrawHelpfulVote', () => {
    it('is idempotent when there was no vote to withdraw', async () => {
      reviews.findOne.mockResolvedValue(
        existingReview({ reviewerId: 'author-1' }),
      );
      transactionManager.count.mockResolvedValue(0);

      const result = await service.withdrawHelpfulVote(
        'lux-cafe',
        'review-1',
        'member-1',
      );

      expect(result).toEqual({
        reviewId: 'review-1',
        helpful: 0,
        hasVoted: false,
      });
      expect(transactionManager.delete).toHaveBeenCalledWith(
        ListingReviewHelpfulVote,
        { reviewId: 'review-1', voterId: 'member-1' },
      );
    });
  });

  describe('askQuestion', () => {
    const question = { body: 'Is the entrance step-free?' };

    it('blocks the owner from asking on their own listing', async () => {
      await expect(
        service.askQuestion('lux-cafe', 'owner-1', question),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(publicQuestions.save).not.toHaveBeenCalled();
    });

    it('rejects a question that is only long enough because of whitespace', async () => {
      await expect(
        service.askQuestion('lux-cafe', 'member-1', { body: 'Hi?     ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('429s a member stacking unanswered questions on one listing', async () => {
      // Three already outstanding and unanswered on this listing.
      publicQuestions.count.mockResolvedValueOnce(3);

      const failure = await service
        .askQuestion('lux-cafe', 'member-1', question)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HttpException);
      expect((failure as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(publicQuestions.save).not.toHaveBeenCalled();
    });

    it('429s a member who has asked too many questions across the directory today', async () => {
      publicQuestions.count
        .mockResolvedValueOnce(0) // nothing outstanding here
        .mockResolvedValueOnce(10); // but ten asked in the last 24h

      const failure = await service
        .askQuestion('lux-cafe', 'member-1', question)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HttpException);
      expect((failure as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });

    it('snapshots the asker name and notifies the owner with the asker as actor', async () => {
      profiles.findOne.mockResolvedValue({
        slug: 'ana-silva',
        firstName: 'Ana',
        lastName: 'Silva',
        avatarUrl: null,
        photoVisible: true,
      });

      const dto = await service.askQuestion('lux-cafe', 'member-1', question);

      expect(dto.askerName).toBe('Ana Silva');
      expect(dto.answer).toBeNull();
      expect(dto.answeredByRole).toBeNull();
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        NotificationType.ListingPublicQuestion,
        expect.objectContaining({
          actorId: 'member-1',
          source: 'listing',
          listingSlug: 'lux-cafe',
        }),
        'member-1',
      );
    });

    it('still posts the question when there is no owner to notify', async () => {
      // `Listing.ownerId` is typed non-nullable on the entity while the column
      // is nullable in the database (`friendly`/`suggested` rows carry no
      // owner), so the fixture states the real row shape directly.
      listings.findOne.mockResolvedValue({
        ...LIVE_LISTING,
        ownerId: null as unknown as string,
      });

      const dto = await service.askQuestion('lux-cafe', 'member-1', question);

      // Unowned listings are exactly the case the moderator answer path exists
      // for, so the question must still be accepted here.
      expect(dto.body).toBe('Is the entrance step-free?');
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('never blocks the question on a failed notification', async () => {
      notifications.create.mockRejectedValue(new Error('bell is down'));

      await expect(
        service.askQuestion('lux-cafe', 'member-1', question),
      ).resolves.toEqual(
        expect.objectContaining({ body: 'Is the entrance step-free?' }),
      );
    });
  });
});
