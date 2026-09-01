import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { HousingViewingStatus } from '../housing-viewings/entities/housing-viewing.entity';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { Profile } from '../users/entities/profile.entity';
import {
  HousingReview,
  HousingReviewAuthorRole,
} from './entities/housing-review.entity';
import { HousingReviewsService } from './housing-reviews.service';
import { toHousingReviewDTO } from './housing-review-response';

/**
 * PRD-47 on the housing side: the lister's right of reply to a review of their
 * home, the author's right to correct their own, and the rules that keep both
 * honest.
 *
 * REVEAL IS THE HINGE, AND IT TURNS BOTH WAYS. Housing reviews are blind: the
 * counterparty's words unlock only once both parties have written or the
 * anti-retaliation window elapses. Everything below hangs off that one moment.
 * A reply OPENS at it, because replying proves the lister has read the review.
 * An edit CLOSES at it, because an edit allowed afterwards would let a member
 * settle their rating only once they had read the other side, which is the end
 * of blindness however carefully the reads are gated. The two are exact
 * complements, so on this surface a review can never be edited after it has
 * been answered.
 *
 * The things covered here are the ones that would be silently wrong if nobody
 * looked:
 *
 *  1. THE REPLY ITSELF: who may write it, that it trims, that it overwrites.
 *  2. THE BLINDNESS RULE ON A REPLY: refused until the review has revealed.
 *     This is the rule this surface has and the business directory does not, so
 *     it is the one most likely to be lost in a future refactor that treats the
 *     two as the same feature.
 *  3. THE KEEP-ON-EDIT RULE: an author editing their review never clears the
 *     lister's reply. Now unreachable defence, kept because it is the line that
 *     matters the day the reveal gate moves.
 *  3b. THE REVEAL GATE ON AN EDIT: refused once the review is public, with a
 *     409 the client can tell apart from the 404 and the 403.
 *  4. THE EDITED-AFTER-REPLY FLAG: still derived honestly from the two
 *     timestamps, and no longer reachable through the service at all.
 *  5. `isYourReviewRevealed` ON THE PAIR: the one field that tells a client
 *     whether the CALLER'S own review has gone public. It exists because the
 *     rest of the DTO describes the counterparty, so the UI was inferring its
 *     own edit window from `counterpartySubmitted` and offering a save control
 *     that the 409 then refused.
 */
describe('HousingReviewsService (PRD-47 lister reply)', () => {
  let service: HousingReviewsService;
  let reviews: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let listings: { findOne: jest.Mock };
  let profiles: { find: jest.Mock };
  let viewings: {
    loadCompletedForReview: jest.Mock;
    loadParticipantViewing: jest.Mock;
  };
  let contentModeration: { stateFor: jest.Mock; statesFor: jest.Mock };
  let reviewReplyNotifier: { notifyReviewReplied: jest.Mock };

  const REVEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-06-01T12:00:00.000Z');

  /** A guest→lister review, submitted a minute ago, so it is inside the blind
   * window unless the pair is complete. */
  const guestReview = (overrides: Partial<HousingReview> = {}) =>
    ({
      id: 'review-1',
      viewingId: 'viewing-1',
      listingId: 'listing-1',
      authorId: 'guest-1',
      subjectId: 'lister-1',
      authorRole: HousingReviewAuthorRole.Requester,
      rating: 2,
      text: 'The lift was out and nobody said so.',
      submittedAt: new Date(NOW.getTime() - 60_000),
      listerReplyText: null,
      listerRepliedAt: null,
      editedAt: null,
      ...overrides,
    }) as HousingReview;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);

    reviews = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      // Default: the pair is complete, so the review has revealed. Individual
      // tests drop this to 1 to put it back behind the blind gate.
      count: jest.fn().mockResolvedValue(2),
      save: jest.fn((row: object) => Promise.resolve(row)),
      create: jest.fn((row: object) => row),
      createQueryBuilder: jest.fn(),
    };
    listings = {
      findOne: jest.fn().mockResolvedValue({
        id: 'listing-1',
        slug: 'benfica-room',
        title: 'Sunny room in Benfica',
        ownerId: 'lister-1',
      }),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    viewings = {
      loadCompletedForReview: jest.fn(),
      loadParticipantViewing: jest.fn(),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    reviewReplyNotifier = {
      notifyReviewReplied: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HousingReviewsService,
        { provide: getRepositoryToken(HousingReview), useValue: reviews },
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: HousingViewingsService, useValue: viewings },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: ReviewReplyNotifier, useValue: reviewReplyNotifier },
      ],
    }).compile();

    service = moduleRef.get(HousingReviewsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. The reply itself
  // -------------------------------------------------------------------------
  describe('replyToReview', () => {
    it('404s a review that does not exist', async () => {
      reviews.findOne.mockResolvedValue(null);

      await expect(
        service.replyToReview('missing-review', 'lister-1', { text: 'Hi' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses anybody who is not the subject of the review', async () => {
      reviews.findOne.mockResolvedValue(guestReview());

      // The guest who WROTE it is not the subject, and neither is a stranger.
      await expect(
        service.replyToReview('review-1', 'guest-1', { text: 'Actually...' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.replyToReview('review-1', 'stranger-1', { text: 'Hello' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('refuses a reply on the PRIVATE lister→guest review, even from its subject', async () => {
      // The lister's review OF THE GUEST. The guest is its subject, so the
      // ownership gate passes; it is refused because there is no public reader
      // for a right of reply to correct.
      reviews.findOne.mockResolvedValue(
        guestReview({
          authorId: 'lister-1',
          subjectId: 'guest-1',
          authorRole: HousingReviewAuthorRole.Lister,
        }),
      );

      await expect(
        service.replyToReview('review-1', 'guest-1', { text: 'Not fair.' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('stores a trimmed reply and stamps the time', async () => {
      reviews.findOne.mockResolvedValue(guestReview());

      const dto = await service.replyToReview('review-1', 'lister-1', {
        text: '  The lift was fixed the next morning.  ',
      });

      expect(reviews.save).toHaveBeenCalledWith(
        expect.objectContaining({
          listerReplyText: 'The lift was fixed the next morning.',
          listerRepliedAt: NOW,
        }),
      );
      expect(dto.listerReply).toEqual({
        text: 'The lift was fixed the next morning.',
        at: NOW.toISOString(),
      });
    });

    it('rejects a whitespace-only reply that class-validator would let through', async () => {
      // `@IsNotEmpty` passes `' '`; it would otherwise strand a real
      // `listerRepliedAt` beside a reply that renders as nothing.
      reviews.findOne.mockResolvedValue(guestReview());

      await expect(
        service.replyToReview('review-1', 'lister-1', { text: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('overwrites an existing reply rather than threading', async () => {
      reviews.findOne.mockResolvedValue(
        guestReview({
          listerReplyText: 'First answer.',
          listerRepliedAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      );

      const dto = await service.replyToReview('review-1', 'lister-1', {
        text: 'Second answer.',
      });

      expect(dto.listerReply).toEqual({
        text: 'Second answer.',
        at: NOW.toISOString(),
      });
    });

    it('renders a removed-member placeholder when the reviewer has erased their account', async () => {
      // `authorId` is ON DELETE SET NULL, so the review survives unattributed.
      reviews.findOne.mockResolvedValue(guestReview({ authorId: null }));

      const dto = await service.replyToReview('review-1', 'lister-1', {
        text: 'Answering for the record.',
      });

      expect(dto.author).toBeNull();
      // Nothing is told to nobody, and no lookup is sent for a user that has gone.
      expect(profiles.find).not.toHaveBeenCalled();
      expect(reviewReplyNotifier.notifyReviewReplied).not.toHaveBeenCalled();
    });

    it('tells the review author through the SHARED review-replied notice', async () => {
      reviews.findOne.mockResolvedValue(guestReview());

      await service.replyToReview('review-1', 'lister-1', { text: 'Sorry.' });

      expect(reviewReplyNotifier.notifyReviewReplied).toHaveBeenCalledWith({
        reviewAuthorId: 'guest-1',
        replyingSubjectId: 'lister-1',
        subjectLabel: 'Sunny room in Benfica',
      });
    });

    it('never fails the reply when the notification does', async () => {
      reviews.findOne.mockResolvedValue(guestReview());
      reviewReplyNotifier.notifyReviewReplied.mockRejectedValue(
        new Error('bell is down'),
      );
      listings.findOne.mockRejectedValue(new Error('listing read failed'));

      // The reply has already committed by then, so it is returned regardless.
      await expect(
        service.replyToReview('review-1', 'lister-1', { text: 'Sorry.' }),
      ).resolves.toMatchObject({ listerReply: { text: 'Sorry.' } });
    });
  });

  // -------------------------------------------------------------------------
  // 2. The blindness rule
  // -------------------------------------------------------------------------
  describe('the blind gate on a reply', () => {
    it('refuses a reply while the review is still blind', async () => {
      // Only the guest has submitted, and it was a minute ago.
      reviews.findOne.mockResolvedValue(guestReview());
      reviews.count.mockResolvedValue(1);

      await expect(
        service.replyToReview('review-1', 'lister-1', { text: 'Got it.' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviews.save).not.toHaveBeenCalled();
      expect(reviewReplyNotifier.notifyReviewReplied).not.toHaveBeenCalled();
    });

    it('allows a reply once BOTH parties have submitted', async () => {
      reviews.findOne.mockResolvedValue(guestReview());
      reviews.count.mockResolvedValue(2);

      await expect(
        service.replyToReview('review-1', 'lister-1', { text: 'Got it.' }),
      ).resolves.toMatchObject({ listerReply: { text: 'Got it.' } });
    });

    it('allows a reply once the anti-retaliation window has elapsed, one-sided', async () => {
      reviews.findOne.mockResolvedValue(
        guestReview({
          submittedAt: new Date(NOW.getTime() - REVEAL_WINDOW_MS - 1),
        }),
      );
      reviews.count.mockResolvedValue(1);

      await expect(
        service.replyToReview('review-1', 'lister-1', { text: 'Got it.' }),
      ).resolves.toMatchObject({ listerReply: { text: 'Got it.' } });
    });

    it('counts pair completeness over the whole VIEWING, never a page of rows', async () => {
      reviews.findOne.mockResolvedValue(guestReview());

      await service.replyToReview('review-1', 'lister-1', { text: 'Got it.' });

      expect(reviews.count).toHaveBeenCalledWith({
        where: { viewingId: 'viewing-1' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. The keep-on-edit rule, and the gate that now sits in front of it
  // -------------------------------------------------------------------------
  describe('updateOwnReview', () => {
    it('refuses anybody who is not the author, including the lister', async () => {
      reviews.findOne.mockResolvedValue(guestReview());

      await expect(
        service.updateOwnReview('review-1', 'lister-1', {
          rating: 5,
          text: 'Lovely, actually.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('refuses an edit on a review whose author has erased their account', async () => {
      // A null `authorId` must never fall to whoever asks for it.
      reviews.findOne.mockResolvedValue(guestReview({ authorId: null }));

      await expect(
        service.updateOwnReview('review-1', 'guest-1', {
          rating: 5,
          text: 'Mine now.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('KEEPS the lister reply, text and timestamp untouched', async () => {
      // A DELIBERATELY IMPOSSIBLE FIXTURE. A reply cannot exist on a review
      // that has not revealed, and an edit cannot land on one that has, so
      // production can no longer reach this row at all. The test stays because
      // the guard it pins is the line that matters the day the reveal gate is
      // loosened: an edit that could clear `listerReplyText` would be a delete
      // button for somebody else's public words, reachable by changing one
      // character. `count` is dropped to 1 so the reveal gate lets the edit
      // through and the keep-the-reply behaviour underneath is what is tested.
      reviews.count.mockResolvedValue(1);
      const repliedAt = new Date('2026-05-20T09:00:00.000Z');
      reviews.findOne.mockResolvedValue(
        guestReview({
          listerReplyText: 'The lift was fixed the next morning.',
          listerRepliedAt: repliedAt,
        }),
      );

      const dto = await service.updateOwnReview('review-1', 'guest-1', {
        rating: 1,
        text: 'It was out for a week.',
      });

      expect(dto.listerReply).toEqual({
        text: 'The lift was fixed the next morning.',
        at: repliedAt.toISOString(),
      });
      expect(reviews.save).toHaveBeenCalledWith(
        expect.objectContaining({
          listerReplyText: 'The lift was fixed the next morning.',
          listerRepliedAt: repliedAt,
        }),
      );
    });

    it('stamps editedAt only when something actually changed', async () => {
      reviews.count.mockResolvedValue(1);
      const unchanged = guestReview();
      reviews.findOne.mockResolvedValue(unchanged);

      const dto = await service.updateOwnReview('review-1', 'guest-1', {
        rating: unchanged.rating,
        // Whitespace around identical words is still identical words.
        text: `  ${unchanged.text}  `,
      });

      expect(dto.editedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3b. THE REVEAL GATE ON AN EDIT
  //
  // The rule this section exists for: you can correct your review until it
  // goes public, and not after. An edit left open past reveal would have ended
  // blindness by the back door, because a guest could read the lister's review
  // of them and only then settle their own rating. The anti-retaliation window
  // would have become the window in which to aim it.
  //
  // Edits therefore close at exactly the instant replies open, which is why
  // these tests mirror `the blind gate on a reply` above in the opposite
  // direction: the same `isRevealed` predicate, the same whole-viewing count,
  // the opposite answer.
  // -------------------------------------------------------------------------
  describe('the reveal gate on an edit', () => {
    it('allows an edit while the review is still blind', async () => {
      // One review on the viewing, submitted a minute ago: nobody can read it
      // yet, so its author may still change it.
      reviews.count.mockResolvedValue(1);
      reviews.findOne.mockResolvedValue(guestReview());

      const dto = await service.updateOwnReview('review-1', 'guest-1', {
        rating: 4,
        text: 'Rewriting this before anyone sees it.',
      });

      expect(dto.rating).toBe(4);
      expect(dto.text).toBe('Rewriting this before anyone sees it.');
      expect(dto.editedAt).toBe(NOW.toISOString());
      expect(reviews.save).toHaveBeenCalled();
    });

    it('refuses an edit once BOTH parties have submitted', async () => {
      reviews.count.mockResolvedValue(2);
      reviews.findOne.mockResolvedValue(guestReview());

      await expect(
        service.updateOwnReview('review-1', 'guest-1', {
          rating: 1,
          text: 'Now that I have read theirs.',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      // The row is never touched, so a refused edit cannot half-apply.
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('refuses an edit once the anti-retaliation window has elapsed, one-sided', async () => {
      // The counterparty never reviewed back, so the window revealed this one
      // on its own. It is public, and public is what closes the edit.
      reviews.count.mockResolvedValue(1);
      reviews.findOne.mockResolvedValue(
        guestReview({
          submittedAt: new Date(NOW.getTime() - REVEAL_WINDOW_MS - 1),
        }),
      );

      await expect(
        service.updateOwnReview('review-1', 'guest-1', {
          rating: 1,
          text: 'Second thoughts, a fortnight on.',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('counts pair completeness over the whole VIEWING, never a page of rows', async () => {
      reviews.count.mockResolvedValue(1);
      reviews.findOne.mockResolvedValue(guestReview());

      await service.updateOwnReview('review-1', 'guest-1', {
        rating: 3,
        text: 'Still blind, still mine to change.',
      });

      expect(reviews.count).toHaveBeenCalledWith({
        where: { viewingId: 'viewing-1' },
      });
    });

    it('tells the refusal apart from not-found and not-yours', async () => {
      // THE POINT OF THIS TEST. Three different things can stop an edit and a
      // member deserves to be told which: there is no such review, it is not
      // yours, or it is yours and it is already public. Collapsing the last one
      // into the 403 would tell somebody they lack permission over their own
      // words, and the frontend could not distinguish "you are too late" from
      // "this was never yours".
      const body = { rating: 3, text: 'Which refusal is this?' };

      reviews.findOne.mockResolvedValue(null);
      const notFound = await service
        .updateOwnReview('review-1', 'guest-1', body)
        .catch((error: unknown) => error);

      reviews.count.mockResolvedValue(1);
      reviews.findOne.mockResolvedValue(guestReview());
      const notYours = await service
        .updateOwnReview('review-1', 'someone-else', body)
        .catch((error: unknown) => error);

      reviews.count.mockResolvedValue(2);
      const alreadyPublic = await service
        .updateOwnReview('review-1', 'guest-1', body)
        .catch((error: unknown) => error);

      expect(notFound).toBeInstanceOf(NotFoundException);
      expect(notYours).toBeInstanceOf(ForbiddenException);
      expect(alreadyPublic).toBeInstanceOf(ConflictException);
      expect([
        (notFound as NotFoundException).getStatus(),
        (notYours as ForbiddenException).getStatus(),
        (alreadyPublic as ConflictException).getStatus(),
      ]).toEqual([404, 403, 409]);
    });

    it('says the review went public, and blames nobody for it', async () => {
      reviews.count.mockResolvedValue(2);
      reviews.findOne.mockResolvedValue(guestReview());

      const error = (await service
        .updateOwnReview('review-1', 'guest-1', {
          rating: 1,
          text: 'Too late.',
        })
        .catch((caught: unknown) => caught)) as ConflictException;

      // The message has to say what happened to the REVIEW rather than what the
      // member did wrong, because they did nothing wrong.
      expect(error.message).toBe(
        'This review has gone public, so it can no longer be changed. A review can be corrected up until the moment it goes public.',
      );
    });

    it('still lets an author edit a review a moderator has taken down', async () => {
      // DELIBERATE ASYMMETRY WITH `replyToReview`, which 404s on a taken-down
      // review. A takedown withholds content from its AUDIENCE, and a member is
      // not their own audience: `forViewing` already keeps `yourReview` for the
      // person who wrote it, so refusing here would contradict the screen they
      // are looking at. The edit notifies nobody and cannot lift the takedown
      // (`dropModeratedReviews` keys on the review id, which an edit does not
      // change), and a takedown is reversible, so leaving the author no way to
      // correct the thing that got their review hidden is the worse outcome.
      reviews.count.mockResolvedValue(1);
      reviews.findOne.mockResolvedValue(guestReview());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      const dto = await service.updateOwnReview('review-1', 'guest-1', {
        rating: 4,
        text: 'Rewritten without the part that got it hidden.',
      });

      expect(dto.text).toBe('Rewritten without the part that got it hidden.');
      // The moderation state is never even consulted on this path, which is
      // what makes the asymmetry a decision rather than an accident.
      expect(contentModeration.stateFor).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. The edited-after-reply flag
  //
  // WHY THIS SECTION NOW READS THE WAY IT DOES. Edits close at reveal and
  // replies open at reveal, so the two windows are exact complements and no
  // housing review can be edited after it has been answered. The flag is
  // therefore structurally false on this surface, and it is KEPT anyway,
  // honestly derived from the two timestamps rather than hardcoded (see the
  // note on `HousingReviewDTO.isEditedAfterListerReply`). These tests pin both
  // halves of that: the derivation still reports whatever a row says, and the
  // service can no longer produce a row that says it.
  // -------------------------------------------------------------------------
  describe('isEditedAfterListerReply', () => {
    it('reports a row whose edit is later than the reply, whatever put it there', async () => {
      const dto = toHousingReviewDTO(
        guestReview({
          listerReplyText: 'The lift was fixed the next morning.',
          listerRepliedAt: new Date('2026-05-20T09:00:00.000Z'),
          editedAt: new Date('2026-05-21T09:00:00.000Z'),
        }),
        null,
      );

      expect(dto.isEditedAfterListerReply).toBe(true);
    });

    it('can no longer be produced through updateOwnReview at all', async () => {
      // A review carrying a reply has by construction revealed, because
      // `replyToReview` refuses to write one before that. So the edit that
      // would move it under the reply is exactly the edit the reveal gate
      // refuses. This is the structural guarantee stated in one test: without
      // it, a guest could post something mild, collect a warm reply, then
      // rewrite the review into an accusation, leaving the lister apparently
      // agreeing with words they never saw.
      reviews.count.mockResolvedValue(2);
      reviews.findOne.mockResolvedValue(
        guestReview({
          listerReplyText: 'The lift was fixed the next morning.',
          listerRepliedAt: new Date('2026-05-20T09:00:00.000Z'),
        }),
      );

      await expect(
        service.updateOwnReview('review-1', 'guest-1', {
          rating: 1,
          text: 'It was out for a week.',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('cannot be manufactured by re-saving an identical review', async () => {
      reviews.count.mockResolvedValue(1);
      const unchanged = guestReview({
        listerReplyText: 'The lift was fixed the next morning.',
        listerRepliedAt: new Date('2026-05-20T09:00:00.000Z'),
      });
      reviews.findOne.mockResolvedValue(unchanged);

      const dto = await service.updateOwnReview('review-1', 'guest-1', {
        rating: unchanged.rating,
        text: `  ${unchanged.text}  `,
      });

      expect(dto.editedAt).toBeNull();
      expect(dto.isEditedAfterListerReply).toBe(false);
    });

    it('stays false for an edit that lands BEFORE the reply', async () => {
      // Ordering is read from the two stamps, not from which write happened
      // last, so a reply written after an edit reads as answering the edit.
      const dto = toHousingReviewDTO(
        guestReview({
          editedAt: new Date('2026-05-01T00:00:00.000Z'),
          listerReplyText: 'Answering the corrected review.',
          listerRepliedAt: new Date('2026-05-02T00:00:00.000Z'),
        }),
        null,
      );

      expect(dto.isEditedAfterListerReply).toBe(false);
    });

    it('stays false when there is an edit but no reply at all', async () => {
      const dto = toHousingReviewDTO(
        guestReview({ editedAt: new Date('2026-05-01T00:00:00.000Z') }),
        null,
      );

      expect(dto.editedAt).toBe('2026-05-01T00:00:00.000Z');
      expect(dto.isEditedAfterListerReply).toBe(false);
      expect(dto.listerReply).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // PRD-47d: a moderator takedown reaches the PRIVATE pair view too
  //
  // `forListing` has dropped moderated reviews since BE-HSG-13. `forViewing`
  // never did, so a hidden review vanished from the public block while the one
  // person it is actually about carried on reading it in the pair view. These
  // tests pin the three halves of the fix: the counterparty's row is withheld,
  // the blind gate is still counted over the raw rows, and the caller's own
  // review is deliberately NOT withheld from the person who wrote it.
  // -------------------------------------------------------------------------
  describe('forViewing takedowns', () => {
    const revealedGuestReview = guestReview({
      submittedAt: new Date(NOW.getTime() - REVEAL_WINDOW_MS - 1),
    });
    const listerReview = guestReview({
      id: 'review-2',
      authorId: 'lister-1',
      subjectId: 'guest-1',
      authorRole: HousingReviewAuthorRole.Lister,
      submittedAt: new Date(NOW.getTime() - REVEAL_WINDOW_MS - 1),
    });

    /** Marks exactly the given review ids as taken down. */
    const takenDown = (...reviewIds: string[]) =>
      new Map(
        reviewIds.map((reviewId) => [
          reviewId,
          { hidden: true, removed: false },
        ]),
      );

    beforeEach(() => {
      viewings.loadParticipantViewing.mockResolvedValue({
        id: 'viewing-1',
        status: HousingViewingStatus.Completed,
        requesterId: 'guest-1',
        listerId: 'lister-1',
        listingId: 'listing-1',
      });
    });

    it('withholds a HIDDEN counterparty review from the person it is about', async () => {
      // The lister opens the pair view. The guest's review of them has been
      // hidden by a moderator. Before PRD-47d they read it here in full.
      reviews.find.mockResolvedValue([revealedGuestReview, listerReview]);
      contentModeration.statesFor.mockResolvedValue(takenDown('review-1'));

      const pair = await service.forViewing('viewing-1', 'lister-1');

      expect(pair.counterpartyReview).toBeNull();
      // Absent, never a tombstone: an unlock promise that will never arrive is
      // a worse answer than "nothing here".
      expect(pair.counterpartySubmitted).toBe(false);
      expect(pair.revealsAt).toBeNull();
    });

    it('withholds a REMOVED counterparty review as well as a hidden one', async () => {
      reviews.find.mockResolvedValue([revealedGuestReview, listerReview]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['review-1', { hidden: false, removed: true }]]),
      );

      const pair = await service.forViewing('viewing-1', 'lister-1');

      expect(pair.counterpartyReview).toBeNull();
      expect(pair.counterpartySubmitted).toBe(false);
    });

    it('never hydrates the author of a review it withholds', async () => {
      reviews.find.mockResolvedValue([revealedGuestReview, listerReview]);
      contentModeration.statesFor.mockResolvedValue(takenDown('review-1'));

      await service.forViewing('viewing-1', 'lister-1');

      // Only the lister's own row is left to resolve a name for. A withheld
      // review must not disclose its author alongside content nobody may read.
      // `MemberLookup` reads through `In(userIds)`, whose `value` is the array.
      const where = profiles.find.mock.calls[0]?.[0] as
        { where?: { userId?: { value?: string[] } } } | undefined;
      const lookedUpUserIds = where?.where?.userId?.value ?? [];
      expect(lookedUpUserIds).not.toContain('guest-1');
      expect(lookedUpUserIds).toContain('lister-1');
    });

    it('still shows a counterparty review nobody has moderated', async () => {
      reviews.find.mockResolvedValue([revealedGuestReview, listerReview]);
      contentModeration.statesFor.mockResolvedValue(new Map());

      const pair = await service.forViewing('viewing-1', 'lister-1');

      expect(pair.counterpartySubmitted).toBe(true);
      expect(pair.counterpartyReview).toMatchObject({ id: 'review-1' });
    });

    it('shows the caller their OWN review even after a takedown', async () => {
      // The takedown withholds content from its audience, and the author is not
      // their own audience. It also has to stay visible: the one-review-per-
      // listing slot is still taken, so `canReview` stays false and nulling the
      // row would leave the member with no explanation and no way to act.
      reviews.find.mockResolvedValue([revealedGuestReview, listerReview]);
      contentModeration.statesFor.mockResolvedValue(takenDown('review-1'));

      const pair = await service.forViewing('viewing-1', 'guest-1');

      expect(pair.youReviewed).toBe(true);
      expect(pair.canReview).toBe(false);
      expect(pair.yourReview).toMatchObject({ id: 'review-1' });
    });

    it('counts the blind gate over the RAW rows, so a takedown cannot re-blind the survivor', async () => {
      // Both parties submitted a minute ago, so the fourteen-day window has NOT
      // elapsed and the pair count is the only thing revealing either review.
      // Taking one down must not drop the survivor back behind the blind gate.
      const freshGuestReview = guestReview();
      const freshListerReview = guestReview({
        id: 'review-2',
        authorId: 'lister-1',
        subjectId: 'guest-1',
        authorRole: HousingReviewAuthorRole.Lister,
      });
      reviews.find.mockResolvedValue([freshGuestReview, freshListerReview]);
      // The GUEST reads the pair. The lister's review of them stands; the
      // guest's own review has been taken down.
      contentModeration.statesFor.mockResolvedValue(takenDown('review-1'));

      const pair = await service.forViewing('viewing-1', 'guest-1');

      expect(pair.counterpartyReview).toMatchObject({ id: 'review-2' });
      expect(pair.revealsAt).toBeNull();
    });

    it('asks the moderation state for the `review` subject, keyed by review id', async () => {
      reviews.find.mockResolvedValue([revealedGuestReview, listerReview]);

      await service.forViewing('viewing-1', 'lister-1');

      expect(contentModeration.statesFor).toHaveBeenCalledWith('review', [
        'review-1',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // `isYourReviewRevealed`: the pair finally answers a question about the
  // CALLER'S OWN review
  //
  // Every other field on the pair DTO describes the counterparty, so a client
  // deciding whether to offer the edit control was inferring its own review's
  // state from `counterpartySubmitted`. That inference is sound in one
  // direction only. The counterparty's row existing means both submitted, which
  // reveals both; its absence means nothing, because the OTHER half of the
  // reveal rule is an elapsed window whose length is server-only. So a review
  // whose counterparty never wrote one and whose window had run out was public
  // on the server and still looked editable on the wire, and the save control
  // the UI offered came back 409.
  //
  // These tests pin all four states, including the one that reads oddly on
  // purpose: a moderated counterparty review is withheld from DISPLAY while
  // still counting for RECIPROCITY, so `isYourReviewRevealed` can be true
  // beside `counterpartySubmitted: false`.
  // -------------------------------------------------------------------------
  describe('isYourReviewRevealed', () => {
    const freshGuestReview = guestReview();
    const freshListerReview = guestReview({
      id: 'review-2',
      authorId: 'lister-1',
      subjectId: 'guest-1',
      authorRole: HousingReviewAuthorRole.Lister,
    });

    beforeEach(() => {
      viewings.loadParticipantViewing.mockResolvedValue({
        id: 'viewing-1',
        status: HousingViewingStatus.Completed,
        requesterId: 'guest-1',
        listerId: 'lister-1',
        listingId: 'listing-1',
      });
    });

    it('is true once BOTH parties have submitted, even a minute ago', async () => {
      // Neither review is anywhere near the fourteen-day window. The complete
      // pair is what reveals them, and it reveals BOTH at the same instant.
      reviews.find.mockResolvedValue([freshGuestReview, freshListerReview]);

      const pair = await service.forViewing('viewing-1', 'guest-1');

      expect(pair.isYourReviewRevealed).toBe(true);
      expect(pair.counterpartySubmitted).toBe(true);
    });

    it('is true when the WINDOW ELAPSED and the counterparty never wrote one', async () => {
      // THE CASE THAT WAS BROKEN. One row on the viewing, submitted just over
      // the anti-retaliation window ago. `forListing` publishes it, so the edit
      // window has closed, and every counterparty-shaped field on this DTO is
      // empty. Before this field the client had no way to know, offered a save
      // control, and got a 409.
      reviews.find.mockResolvedValue([
        guestReview({
          submittedAt: new Date(NOW.getTime() - REVEAL_WINDOW_MS - 1),
        }),
      ]);

      const pair = await service.forViewing('viewing-1', 'guest-1');

      expect(pair.isYourReviewRevealed).toBe(true);
      // The fields that could not tell this story, spelled out so a future
      // reader does not mistake them for a second copy of the signal.
      expect(pair.counterpartySubmitted).toBe(false);
      expect(pair.counterpartyReview).toBeNull();
      expect(pair.revealsAt).toBeNull();
    });

    it('is false while the review is still blind, so the edit stays open', async () => {
      // One row, submitted a minute ago: the pair is incomplete and the window
      // has not run. This is the only state in which `updateOwnReview` accepts
      // a change, and it is the only state in which the save control shows.
      reviews.find.mockResolvedValue([freshGuestReview]);

      const pair = await service.forViewing('viewing-1', 'guest-1');

      expect(pair.isYourReviewRevealed).toBe(false);
    });

    it('is false for a member who has not written a review at all', async () => {
      // Nothing of theirs to reveal. The submit form shows; the edit form is
      // not in the conversation.
      reviews.find.mockResolvedValue([freshListerReview]);

      const pair = await service.forViewing('viewing-1', 'guest-1');

      expect(pair.isYourReviewRevealed).toBe(false);
      expect(pair.youReviewed).toBe(false);
      expect(pair.canReview).toBe(true);
    });

    it('follows the BLIND gate and not the display flag when the counterparty is moderated', async () => {
      // THE SECOND BROKEN CASE. Both parties submitted a minute ago, so the
      // guest's review revealed the moment the lister filed theirs. A moderator
      // then took the LISTER's review down, which withholds it from display and
      // clears `counterpartySubmitted`. The guest's own review is still public
      // on the listing and still uneditable, so the flag has to say so.
      //
      // Reveal counts RAW rows on purpose: reading it off the surviving ones
      // would re-blind a review that had already gone public and restart a
      // fourteen-day window that had already run.
      reviews.find.mockResolvedValue([freshGuestReview, freshListerReview]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['review-2', { hidden: true, removed: false }]]),
      );

      const pair = await service.forViewing('viewing-1', 'guest-1');

      expect(pair.isYourReviewRevealed).toBe(true);
      // The two fields disagree, and both are right. This assertion is here so
      // that anybody who "fixes" the disagreement has to delete it on purpose.
      expect(pair.counterpartySubmitted).toBe(false);
      expect(pair.counterpartyReview).toBeNull();
    });

    it('agrees with the gate `updateOwnReview` applies to the same rows', async () => {
      // The point of the field: what the pair says about editability and what
      // the PATCH does about it are the same predicate over the same count. A
      // window-elapsed review with no counterparty reads revealed above, and
      // the edit of it is refused with the 409 the client tells apart.
      const elapsed = guestReview({
        submittedAt: new Date(NOW.getTime() - REVEAL_WINDOW_MS - 1),
      });
      reviews.findOne.mockResolvedValue(elapsed);
      reviews.count.mockResolvedValue(1);

      await expect(
        service.updateOwnReview('review-1', 'guest-1', {
          rating: 4,
          text: 'On reflection the lift was fixed the next morning.',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(reviews.save).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PRD-47d: a taken-down review cannot be replied to either
  // -------------------------------------------------------------------------
  describe('replyToReview on moderated content', () => {
    it('404s a reply to a review a moderator has hidden', async () => {
      reviews.findOne.mockResolvedValue(guestReview());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        service.replyToReview('review-1', 'lister-1', { text: 'Not true.' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviews.save).not.toHaveBeenCalled();
      // And the guest is never pinged about a reply nobody can read.
      expect(reviewReplyNotifier.notifyReviewReplied).not.toHaveBeenCalled();
    });

    it('404s a reply to a review a moderator has removed', async () => {
      reviews.findOne.mockResolvedValue(guestReview());
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });

      await expect(
        service.replyToReview('review-1', 'lister-1', { text: 'Not true.' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviews.save).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Who the public block hands the compose affordance to
  // -------------------------------------------------------------------------
  describe('forListing', () => {
    const revealedRow = guestReview({
      submittedAt: new Date(NOW.getTime() - REVEAL_WINDOW_MS - 1),
    });

    beforeEach(() => {
      reviews.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      reviews.find.mockResolvedValue([revealedRow]);
    });

    it('marks the lister, and only the lister, as able to reply', async () => {
      await expect(
        service.forListing('benfica-room', 'lister-1'),
      ).resolves.toMatchObject({ isViewerTheLister: true, count: 1 });

      await expect(
        service.forListing('benfica-room', 'guest-1'),
      ).resolves.toMatchObject({ isViewerTheLister: false });
    });

    it('does not match a null owner against a null viewer', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'benfica-room',
        title: 'Sunny room in Benfica',
        ownerId: null,
      });

      await expect(
        service.forListing('benfica-room', null),
      ).resolves.toMatchObject({ isViewerTheLister: false });
    });
  });
});
