import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReviewReplyNotifier } from './review-reply-notifier.service';
import { SubmissionDecisionNotifier } from './submission-decision-notifier.service';

/**
 * The shared intake primitive (PRD-48): the two notifiers every submission
 * surface uses to close its own loop, so "did the person who submitted this
 * hear back?" is answered once for the platform rather than once per feature.
 *
 * NO CONTROLLER AND NO ENTITY, deliberately. There is no `submissions` table
 * and there is not going to be one: each intake keeps its own row, its own
 * status vocabulary and its own decision endpoint, because those are genuinely
 * different (a barter proposal is decided by another member, a partner
 * application by staff). What was missing was never storage. It was the one
 * shared answer at the end, and that is all this module holds.
 *
 * `NotificationsModule` is a plain import with no `forwardRef`: it pulls in
 * `SocialModule`, `CommunityMembershipModule` and TypeORM features only, none
 * of which reaches back here.
 *
 * HOW AN INTAKE ADOPTS IT: import `SubmissionsModule` in that feature's module,
 * inject `SubmissionDecisionNotifier`, map the intake's own terminal statuses
 * onto `SubmissionOutcome` at the decision endpoint, and call `notifyDecided`
 * once, AFTER the decision has committed. Add the kind to `SubmissionKind`
 * first: `SUBMISSION_KIND_NOTIFICATION` is total over that enum, so the build
 * stops until somebody has decided what the submitter is told.
 */
@Module({
  imports: [NotificationsModule],
  providers: [SubmissionDecisionNotifier, ReviewReplyNotifier],
  exports: [SubmissionDecisionNotifier, ReviewReplyNotifier],
})
export class SubmissionsModule {}
