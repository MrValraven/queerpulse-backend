import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { ReviewReplyNotifier } from './review-reply-notifier.service';
import { SubmissionDecisionNotifier } from './submission-decision-notifier.service';
import {
  SUBMISSION_KINDS,
  SUBMISSION_KIND_NOTIFICATION,
  SubmissionKind,
  SubmissionOutcome,
} from './submission-kinds';

const SUBMITTER_ID = 'submitter-1';
const REVIEWER_ID = 'reviewer-1';
const OWNER_ID = 'owner-1';

describe('SubmissionDecisionNotifier', () => {
  let notifier: SubmissionDecisionNotifier;
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    notifications = { create: jest.fn().mockResolvedValue({ id: 'row-1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SubmissionDecisionNotifier,
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    notifier = moduleRef.get(SubmissionDecisionNotifier);
  });

  it('writes exactly one submission_decided row carrying both discriminators', async () => {
    await notifier.notifyDecided({
      recipientId: SUBMITTER_ID,
      kind: SubmissionKind.ResourceSuggestion,
      outcome: SubmissionOutcome.Accepted,
      subjectLabel: 'Casa Trans drop-in',
    });

    expect(notifications.create).toHaveBeenCalledTimes(1);
    const [recipientId, type, payload, actorId] =
      notifications.create.mock.calls[0];
    expect(recipientId).toBe(SUBMITTER_ID);
    expect(type).toBe(NotificationType.SubmissionDecided);
    expect(payload).toMatchObject({
      kind: 'resource_suggestion',
      outcome: 'accepted',
      subjectLabel: 'Casa Trans drop-in',
    });
    // NO ACTOR, ever: the platform reports on the member's own submission, so
    // a block between them and whoever decided can never swallow the answer.
    expect(actorId).toBeUndefined();
  });

  it('never passes an actor for any kind or outcome', async () => {
    for (const kind of SUBMISSION_KINDS) {
      for (const outcome of Object.values(SubmissionOutcome)) {
        await notifier.notifyDecided({
          recipientId: SUBMITTER_ID,
          kind,
          outcome,
          subjectLabel: 'A submission',
        });
      }
    }
    for (const call of notifications.create.mock.calls) {
      expect(call[3]).toBeUndefined();
      expect(call[2]).not.toHaveProperty('actorId');
    }
  });

  it('carries the reviewer note for a kind that has nowhere else to read it', async () => {
    await notifier.notifyDecided({
      recipientId: SUBMITTER_ID,
      kind: SubmissionKind.PartnerApplication,
      outcome: SubmissionOutcome.Declined,
      subjectLabel: 'Casa Trans',
      reviewNote: 'We only list organisations operating in Lisbon.',
    });
    expect(notifications.create.mock.calls[0][2].reviewNote).toBe(
      'We only list organisations operating in Lisbon.',
    );
  });

  it('drops the reviewer note for a kind whose config withholds it', async () => {
    // The `StorySubmissionDecided` case: a kind with its own tracker page turns
    // `isReviewNoteDelivered` off, and the note must then never be written at
    // all rather than merely be dropped later by the payload allowlist.
    const kind = SubmissionKind.BarterProposal;
    const original = SUBMISSION_KIND_NOTIFICATION[kind];
    SUBMISSION_KIND_NOTIFICATION[kind] = {
      ...original,
      isReviewNoteDelivered: false,
    };
    try {
      await notifier.notifyDecided({
        recipientId: SUBMITTER_ID,
        kind,
        outcome: SubmissionOutcome.Declined,
        subjectLabel: 'A bike for a haircut',
        reviewNote: 'Already swapped.',
      });
    } finally {
      SUBMISSION_KIND_NOTIFICATION[kind] = original;
    }
    expect(notifications.create.mock.calls[0][2]).not.toHaveProperty(
      'reviewNote',
    );
  });

  it('omits a blank label instead of interpolating a gap into the copy', async () => {
    await notifier.notifyDecided({
      recipientId: SUBMITTER_ID,
      kind: SubmissionKind.BarterProposal,
      outcome: SubmissionOutcome.Archived,
      subjectLabel: '   ',
      reviewNote: '  ',
    });
    const payload = notifications.create.mock.calls[0][2];
    expect(payload).not.toHaveProperty('subjectLabel');
    expect(payload).not.toHaveProperty('reviewNote');
  });

  it('writes no slug for a kind that has no deep link to point at', async () => {
    // Written against a STUBBED config rather than a real kind. Every shipped
    // kind now has a `deepLinkSource` (they gained one when /account/submissions
    // landed and gave them somewhere to point), so naming a live kind here
    // would assert the opposite of what it means to. The rule under test is
    // that a `deepLinkSlug` supplied by a caller is discarded unless the kind's
    // own config claims a source, which is what keeps a stray slug out of the
    // payload of a row the client cannot build a link for.
    const kind = SubmissionKind.PartnerApplication;
    const original = SUBMISSION_KIND_NOTIFICATION[kind];
    SUBMISSION_KIND_NOTIFICATION[kind] = { ...original, deepLinkSource: null };
    try {
      await notifier.notifyDecided({
        recipientId: SUBMITTER_ID,
        kind,
        outcome: SubmissionOutcome.Accepted,
        subjectLabel: 'Casa Trans',
        deepLinkSlug: 'casa-trans',
      });
    } finally {
      SUBMISSION_KIND_NOTIFICATION[kind] = original;
    }
    const payload = notifications.create.mock.calls[0][2];
    expect(payload).not.toHaveProperty('source');
    expect(payload).not.toHaveProperty('listingSlug');
  });

  it('writes the deep-link source for a kind whose config claims one', async () => {
    // The mirror of the case above, and the reason it had to be rewritten
    // rather than deleted: a kind that DOES claim a source must put it in the
    // payload, or `sourceHrefFromPayload` has nothing to resolve and the row
    // renders as text when it should be a link.
    await notifier.notifyDecided({
      recipientId: SUBMITTER_ID,
      kind: SubmissionKind.PartnerApplication,
      outcome: SubmissionOutcome.Accepted,
      subjectLabel: 'Casa Trans',
    });
    expect(notifications.create.mock.calls[0][2]).toHaveProperty(
      'source',
      SUBMISSION_KIND_NOTIFICATION[SubmissionKind.PartnerApplication]
        .deepLinkSource,
    );
  });

  it('writes nothing when there is no recipient', async () => {
    await notifier.notifyDecided({
      recipientId: '',
      kind: SubmissionKind.PartnerApplication,
      outcome: SubmissionOutcome.Accepted,
      subjectLabel: 'Casa Trans',
    });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('swallows a notification failure so the decision cannot be rolled back', async () => {
    notifications.create.mockRejectedValueOnce(new Error('bell is down'));
    await expect(
      notifier.notifyDecided({
        recipientId: SUBMITTER_ID,
        kind: SubmissionKind.ResourceSuggestion,
        outcome: SubmissionOutcome.Declined,
        subjectLabel: 'A resource',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('ReviewReplyNotifier', () => {
  let notifier: ReviewReplyNotifier;
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    notifications = { create: jest.fn().mockResolvedValue({ id: 'row-1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewReplyNotifier,
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    notifier = moduleRef.get(ReviewReplyNotifier);
  });

  it('carries the replying subject as the actor so block and mute apply', async () => {
    await notifier.notifyReviewReplied({
      reviewAuthorId: REVIEWER_ID,
      replyingSubjectId: OWNER_ID,
      subjectLabel: 'Lux Cafe',
      deepLinkSource: 'listing',
      deepLinkSlug: 'lux-cafe',
    });

    const [recipientId, type, payload, actorId] =
      notifications.create.mock.calls[0];
    expect(recipientId).toBe(REVIEWER_ID);
    expect(type).toBe(NotificationType.ReviewReplied);
    expect(payload).toMatchObject({
      actorId: OWNER_ID,
      subjectLabel: 'Lux Cafe',
      source: 'listing',
      listingSlug: 'lux-cafe',
    });
    expect(actorId).toBe(OWNER_ID);
  });

  it('names nobody when a moderator wrote the reply', async () => {
    await notifier.notifyReviewReplied({
      reviewAuthorId: REVIEWER_ID,
      replyingSubjectId: null,
      subjectLabel: 'Lux Cafe',
    });
    const [, , payload, actorId] = notifications.create.mock.calls[0];
    expect(payload).not.toHaveProperty('actorId');
    expect(actorId).toBeUndefined();
  });

  // The bug these four cover: `replyingSubjectId` carried both the NAME and the
  // block/mute gate, so a caller passing `null` to hide an anonymous business
  // owner also dropped the safety gate, and a reviewer who had blocked that
  // owner received the row anyway. The two questions are now two fields.
  describe('withholding a name never withholds the block/mute gate', () => {
    it('still passes the real replier as the gate actor on an unnamed row', async () => {
      await notifier.notifyReviewReplied({
        reviewAuthorId: REVIEWER_ID,
        // The business page names nobody, so the row must not either.
        replyingSubjectId: null,
        blockGateActorId: OWNER_ID,
        subjectLabel: 'Lux Cafe',
      });

      const [, , payload, actorId] = notifications.create.mock.calls[0];
      expect(payload).not.toHaveProperty('actorId');
      // `NotificationsService.create` suppresses the write when this member is
      // hidden from the recipient, so a reviewer who blocked the owner is
      // unreachable even though the row would have named nobody.
      expect(actorId).toBe(OWNER_ID);
    });

    it('leaves the row unwritten when the gate actor is hidden from the reviewer', async () => {
      // `create` returns null for a suppressed write; the notifier's contract is
      // that it hands the decision to `create` rather than deciding itself.
      notifications.create.mockResolvedValueOnce(null);

      await expect(
        notifier.notifyReviewReplied({
          reviewAuthorId: REVIEWER_ID,
          replyingSubjectId: null,
          blockGateActorId: OWNER_ID,
          subjectLabel: 'Lux Cafe',
        }),
      ).resolves.toBeUndefined();

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create.mock.calls[0][3]).toBe(OWNER_ID);
    });

    it('falls the gate back to the named replier for callers that withhold nothing', async () => {
      // The employer and housing reply sites never hide a name, so they pass no
      // `blockGateActorId` and must keep exactly the behaviour they had.
      await notifier.notifyReviewReplied({
        reviewAuthorId: REVIEWER_ID,
        replyingSubjectId: OWNER_ID,
        subjectLabel: 'Lux Cafe',
      });

      const [, , payload, actorId] = notifications.create.mock.calls[0];
      expect(payload).toMatchObject({ actorId: OWNER_ID });
      expect(actorId).toBe(OWNER_ID);
    });

    it('says nothing when the unnamed replier is the review author themself', async () => {
      // A co-manager can review the listing they help run, and their reply is
      // never named. The self-reply guard has to read the real member, or
      // withholding the name would resurrect a notification to yourself.
      await notifier.notifyReviewReplied({
        reviewAuthorId: REVIEWER_ID,
        replyingSubjectId: null,
        blockGateActorId: REVIEWER_ID,
        subjectLabel: 'Lux Cafe',
      });

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  it('never carries the reply text, because there is no parameter for it', async () => {
    await notifier.notifyReviewReplied({
      reviewAuthorId: REVIEWER_ID,
      replyingSubjectId: OWNER_ID,
      subjectLabel: 'Lux Cafe',
    });
    const payload = notifications.create.mock.calls[0][2];
    for (const forbidden of ['text', 'body', 'reply', 'message', 'excerpt']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('says nothing when the author answered their own review', async () => {
    await notifier.notifyReviewReplied({
      reviewAuthorId: REVIEWER_ID,
      replyingSubjectId: REVIEWER_ID,
      subjectLabel: 'Lux Cafe',
    });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('says nothing when the review has no author left to tell', async () => {
    await notifier.notifyReviewReplied({
      reviewAuthorId: null,
      replyingSubjectId: OWNER_ID,
      subjectLabel: 'Lux Cafe',
    });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('swallows a notification failure so the reply cannot be rolled back', async () => {
    notifications.create.mockRejectedValueOnce(new Error('bell is down'));
    await expect(
      notifier.notifyReviewReplied({
        reviewAuthorId: REVIEWER_ID,
        replyingSubjectId: OWNER_ID,
        subjectLabel: 'Lux Cafe',
      }),
    ).resolves.toBeUndefined();
  });
});
