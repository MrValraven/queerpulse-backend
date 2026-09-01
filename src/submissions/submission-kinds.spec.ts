import { NotificationType } from '../notifications/entities/notification.entity';
import {
  SUBMISSION_KINDS,
  SUBMISSION_KIND_NOTIFICATION,
  SubmissionKind,
  SubmissionOutcome,
} from './submission-kinds';

/**
 * The compiler is the real guard on `SUBMISSION_KIND_NOTIFICATION`: it is a
 * total `Record<SubmissionKind, ...>`, so adding a kind stops the file
 * compiling until somebody decides what the submitter is told. These tests
 * cover what the type system cannot say: that no entry was quietly emptied out,
 * and that the vocabularies stay the ones the shipped copy and the shipped enum
 * labels are keyed on.
 */
describe('submission kinds', () => {
  it('configures every kind, with nothing left over', () => {
    expect(Object.keys(SUBMISSION_KIND_NOTIFICATION).sort()).toEqual(
      [...SUBMISSION_KINDS].sort(),
    );
  });

  it('gives every kind a real decision on both questions', () => {
    for (const kind of SUBMISSION_KINDS) {
      const config = SUBMISSION_KIND_NOTIFICATION[kind];
      // `null` is a real answer for the deep link and `false` a real answer for
      // the note; `undefined` is an omission, which is the thing this shape
      // exists to make impossible.
      expect(config.deepLinkSource).not.toBeUndefined();
      expect(typeof config.isReviewNoteDelivered).toBe('boolean');
    }
  });

  it('never claims a deep link the frontend adapter cannot build', () => {
    // Mirrors the `source` branches in `sourceHrefFromPayload`
    // (`queerpulse/src/features/notifications/api/notifications.adapters.ts`).
    // A kind pointing anywhere else would render a row that looks clickable and
    // silently is not.
    const resolvableSources = [
      'listing',
      'community',
      'event',
      'job',
      // `/work/barter/mine` and `/account/submissions`. Both branches exist in
      // the adapter; adding either here before the branch is what the closed
      // `SubmissionDeepLinkSource` union exists to prevent.
      'barter',
      'submission',
    ];
    for (const kind of SUBMISSION_KINDS) {
      const source = SUBMISSION_KIND_NOTIFICATION[kind].deepLinkSource;
      if (source !== null) {
        expect(resolvableSources).toContain(source);
      }
    }
  });

  it('sends each kind to the page that is about that submission', () => {
    // PRD-48's member-facing half. Every kind now has somewhere to land: the
    // submissions index for the two staff-reviewed intakes, and the proposer's
    // own half of the skill exchange for a swap, which holds the listing the
    // offer was made against as well as the thread it opened.
    expect(
      SUBMISSION_KIND_NOTIFICATION[SubmissionKind.PartnerApplication]
        .deepLinkSource,
    ).toBe('submission');
    expect(
      SUBMISSION_KIND_NOTIFICATION[SubmissionKind.ResourceSuggestion]
        .deepLinkSource,
    ).toBe('submission');
    expect(
      SUBMISSION_KIND_NOTIFICATION[SubmissionKind.BarterProposal]
        .deepLinkSource,
    ).toBe('barter');
  });

  it('keeps the wire values the shipped copy keys off', () => {
    // These strings land on `payload.kind` / `payload.outcome` and are the copy
    // keys on the frontend (`notifications:type.submission_decided.<kind>.<outcome>`).
    // Renaming one orphans the copy and every row already written.
    expect(SUBMISSION_KINDS).toEqual([
      'partner_application',
      'barter_proposal',
      'resource_suggestion',
    ]);
    expect(Object.values(SubmissionOutcome)).toEqual([
      'accepted',
      'declined',
      'archived',
    ]);
  });

  it('leaves the intakes that already speak on their own notification types', () => {
    // PRD-48 is about the intakes that told their submitter NOTHING. The ones
    // that already report back keep their shipped enum labels and their shipped
    // copy: folding them in would be a data migration over live bell rows to
    // gain nothing a member can see. Asserted so a later tidy-up has to argue
    // with a test rather than with nobody.
    const alreadySpeaking = [
      NotificationType.VolunteerApplicationDecided,
      NotificationType.WriterApplicationApproved,
      NotificationType.WriterApplicationDeclined,
      NotificationType.ChangemakerNominationApproved,
      NotificationType.ChangemakerNominationDismissed,
      NotificationType.IntakeReviewed,
    ];
    for (const type of alreadySpeaking) {
      expect(SUBMISSION_KINDS).not.toContain(type as unknown as SubmissionKind);
    }
  });
});
