import { ObjectLiteral } from 'typeorm';
import {
  DsarRequest,
  DsarStatus,
} from '../account/entities/dsar-request.entity';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import {
  BanEvasionEscalation,
  BanEvasionEscalationStatus,
} from '../ban-evasion/entities/ban-evasion-escalation.entity';
import {
  ChangemakerNomination,
  ChangemakerNominationStatus,
} from '../changemakers/entities/changemaker-nomination.entity';
import {
  CommunityOwnerReviewRequest,
  CommunityOwnerReviewRequestStatus,
} from '../communities/entities/community-owner-review-request.entity';
import {
  CommunityTagRequest,
  CommunityTagRequestStatus,
} from '../communities/entities/community-tag-request.entity';
import {
  GroupListing,
  GroupListingStatus,
} from '../housing-groups/entities/group-listing.entity';
import {
  HousingListing,
  HousingListingStatus,
} from '../housing-listings/entities/housing-listing.entity';
import {
  CoopJoinRequest,
  JoinRequestStatus,
} from '../housing/entities/coop-join-request.entity';
import { IntakeSubmission } from '../intakes/entities/intake-submission.entity';
import {
  Landlord,
  LandlordStatus,
} from '../landlords/entities/landlord.entity';
import {
  LandlordIntroRequest,
  LandlordIntroRequestStatus,
} from '../landlords/entities/landlord-intro-request.entity';
import { LegalRequest } from '../legal-requests/entities/legal-request.entity';
import { LegalRequestOutcome } from '../legal-requests/legal-request-vocabulary';
import {
  ListingClaim,
  ListingClaimStatus,
} from '../listings/entities/listing-claim.entity';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from '../listings/entities/listing-edit-suggestion.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import {
  MagazineStorySubmission,
  SubmissionStatus,
} from '../magazine/entities/magazine-story-submission.entity';
import {
  MagazineWriterApplication,
  WriterApplicationStatus,
} from '../magazine/entities/magazine-writer-application.entity';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from '../membership/entities/join-request.entity';
import { Appeal, AppealStatus } from '../moderation/entities/appeal.entity';
import {
  BanRatification,
  BanRatificationStatus,
} from '../moderation/entities/ban-ratification.entity';
import { Partner, PartnerStatus } from '../partners/entities/partner.entity';
import {
  ReadingGroupProposal,
  ReadingGroupProposalStatus,
} from '../reading-group-proposals/entities/reading-group-proposal.entity';
import { Report, ReportStatus } from '../reports/entities/report.entity';
import {
  RoadmapIdea,
  RoadmapIdeaStatus,
} from '../roadmap/entities/roadmap-idea.entity';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from '../resources/entities/resource-suggestion.entity';
import { Resource } from '../resources/entities/resource.entity';
import { SafeSpaceFlag } from '../safe-space-nominations/entities/safe-space-flag.entity';
import {
  SAFE_SPACE_NOMINATION_OPEN_STATUSES,
  SafeSpaceNomination,
} from '../safe-space-nominations/entities/safe-space-nomination.entity';
import { SAFE_SPACE_ACKNOWLEDGEMENT_HOURS } from '../safe-space-nominations/safe-space-policy';
import { VerificationRequest } from '../verification/entities/verification-request.entity';
import { VerificationRequestStatus } from '../verification/verification-request-status';
import {
  AdminExtraQueueKey,
  AdminTriageQueueKey,
} from './admin-queues-response';

/**
 * WHERE each queue's backlog is, in one table.
 *
 * The single most valuable property of this file is that it is a
 * `Record<AdminQueueKey, ...>`: the day somebody appends a key to
 * `ADMIN_QUEUE_REGISTRY`, this file stops compiling until they say what
 * "waiting" means in their new queue. The alternative — a hand-curated list
 * beside the taxonomy it mirrors — is drift nobody sees until the console has
 * been quietly missing a queue for months.
 *
 * ## What "waiting" means
 *
 * Waiting on STAFF, never waiting on the member. A housing listing in
 * `question` has been sent back to the lister with a reason and is theirs to
 * answer; a listing in `review` is ours. A waitlisted join request has been
 * decided for now. Getting this wrong in the generous direction would make the
 * console permanently red with work nobody can do, which is the same as having
 * no console.
 *
 * ## Where the deadlines come from
 *
 * Every deadline below is read off the column or constant that already owns it,
 * never restated as a fresh literal here: `reports.sla_due_at` and
 * `appeals.sla_due_at` (`report-severity.ts`, `appeal-window.ts`),
 * `dsar_request.due_by` (`DSAR_DUE_DAYS`), `ban_ratifications.expires_at`
 * (`BAN_RATIFICATION_WINDOW_HOURS`), the shared `due_at` that
 * `QueueAssignmentColumns` gave four queues (`intake-sla.ts` and friends), the
 * guide `review_due_on` PRD-270 added, and
 * `SAFE_SPACE_ACKNOWLEDGEMENT_HOURS` for the one queue whose clock is derived
 * rather than stored. A second copy of a promised number is a promise that can
 * drift from the one the platform actually published.
 *
 * A queue with no deadline says `null`, and the console renders that as
 * "no clock" rather than as "on time".
 */

/** A SQL fragment plus whatever it binds. Written against physical columns. */
export interface QueueCounterSql {
  sql: string;
  parameters: ObjectLiteral;
}

/**
 * Resolves an entity property to its quoted, alias-qualified physical column
 * (`"queue_row"."sla_due_at"`).
 *
 * Physical rather than TypeORM's `alias.property` shorthand because these
 * fragments land inside aggregate SELECT expressions and `FILTER (WHERE ...)`
 * clauses, where the query builder does no property translation at all. The
 * service resolves the name from entity METADATA rather than from a string in
 * this file, so a renamed column fails loudly instead of counting the wrong
 * thing.
 */
export type QueueColumnRef<Entity> = (
  property: keyof Entity & string,
) => string;

/** How to count one queue. Erased of its entity type for storage. */
export interface AdminQueueCounter {
  entity: { new (): ObjectLiteral };
  /** The property whose value is "this row started waiting at". */
  waitingSinceProperty: string;
  /** Restricts the table to rows still waiting on staff. */
  buildWaitingWhere: QueueCounterBuilder;
  /**
   * SQL yielding the row's deadline instant, or NULL for a row that has none.
   * `null` here means the queue has no deadline at all.
   */
  buildDeadline: QueueCounterBuilder | null;
}

type QueueCounterBuilder = (
  column: QueueColumnRef<ObjectLiteral>,
) => QueueCounterSql;

/**
 * The parameter every counter may reference for "now". Bound once by the
 * service so a single request measures every queue against the same instant:
 * two queues answering from clocks a few milliseconds apart would let a console
 * show a total that does not match its own rows.
 */
export const QUEUE_NOW_PARAMETER = 'nowInstant';

/**
 * Type-checks one counter against its own entity, then erases it for storage.
 *
 * The generic is what makes `waitingSince: 'createdAt'` and every `column(...)`
 * call below a compile-time check against the real entity rather than a string
 * that fails at runtime on the one queue nobody opened this week.
 */
function queueCounter<Entity extends ObjectLiteral>(specification: {
  entity: { new (): Entity };
  waitingSince: keyof Entity & string;
  waiting: (column: QueueColumnRef<Entity>) => QueueCounterSql;
  deadline?: (column: QueueColumnRef<Entity>) => QueueCounterSql;
}): AdminQueueCounter {
  return {
    entity: specification.entity,
    waitingSinceProperty: specification.waitingSince,
    buildWaitingWhere: specification.waiting,
    buildDeadline: specification.deadline ?? null,
  };
}

/**
 * Every registry queue, and how to count it. `null` means the queue records no
 * worked/unworked state at all, so nothing here can honestly say what is
 * waiting in it.
 */
export const ADMIN_REGISTRY_QUEUE_COUNTERS: Record<
  AdminQueueKey,
  AdminQueueCounter | null
> = {
  [AdminQueueKey.InviteRequests]: queueCounter({
    entity: PlatformJoinRequest,
    waitingSince: 'createdAt',
    // `waitlisted` is a decision, not a wait: the reviewer has answered and the
    // applicant is being held deliberately.
    waiting: (column) => ({
      sql: `${column('status')} = :inviteRequestStatus`,
      parameters: { inviteRequestStatus: PlatformJoinRequestStatus.Pending },
    }),
    deadline: (column) => ({ sql: column('dueAt'), parameters: {} }),
  }),

  [AdminQueueKey.Appeals]: queueCounter({
    entity: Appeal,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :appealStatus`,
      parameters: { appealStatus: AppealStatus.Awaiting },
    }),
    // The 7-day promise from Code of Conduct §05, stamped at filing by
    // `appealDecisionDueAt` (`moderation/appeal-window.ts`).
    deadline: (column) => ({ sql: column('slaDueAt'), parameters: {} }),
  }),

  [AdminQueueKey.BanRatifications]: queueCounter({
    entity: BanRatification,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :banRatificationStatus`,
      parameters: { banRatificationStatus: BanRatificationStatus.Pending },
    }),
    // The 72-hour hold (`BAN_RATIFICATION_WINDOW_HOURS`). A pending hold past
    // this instant is one the sweeper has not expired yet, and the member is
    // still serving an interim suspension nobody has confirmed. That is
    // precisely the "lapsing ratification" the finding asked to surface.
    deadline: (column) => ({ sql: column('expiresAt'), parameters: {} }),
  }),

  [AdminQueueKey.Verification]: queueCounter({
    entity: VerificationRequest,
    waitingSince: 'createdAt',
    // The same three states `VerificationService` treats as open: in the review
    // loop, not decided, not withdrawn. `in_review` is claimed but unanswered,
    // which is still work outstanding.
    waiting: (column) => ({
      sql: `${column('status')} IN (:...verificationStatuses)`,
      parameters: {
        verificationStatuses: [
          VerificationRequestStatus.Pending,
          VerificationRequestStatus.InReview,
          VerificationRequestStatus.Appealing,
        ],
      },
    }),
    deadline: (column) => ({ sql: column('dueAt'), parameters: {} }),
  }),

  [AdminQueueKey.Dsar]: queueCounter({
    entity: DsarRequest,
    waitingSince: 'submittedAt',
    waiting: (column) => ({
      sql: `${column('status')} IN (:...dsarStatuses)`,
      parameters: {
        dsarStatuses: [DsarStatus.Received, DsarStatus.InReview],
      },
    }),
    // The statutory 30-day clock (`DSAR_DUE_DAYS`), stamped at submission. The
    // one deadline in this file that is a legal obligation rather than a
    // promise the platform made itself, and the one the finding singles out.
    deadline: (column) => ({ sql: column('dueBy'), parameters: {} }),
  }),

  [AdminQueueKey.HousingListings]: queueCounter({
    entity: HousingListing,
    waitingSince: 'createdAt',
    // `question` is with the lister, not with us.
    waiting: (column) => ({
      sql: `${column('status')} = :housingListingStatus`,
      parameters: { housingListingStatus: HousingListingStatus.Review },
    }),
  }),

  [AdminQueueKey.HousingGroupListings]: queueCounter({
    entity: GroupListing,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :groupListingStatus`,
      parameters: { groupListingStatus: GroupListingStatus.Review },
    }),
  }),

  [AdminQueueKey.LandlordIntroRequests]: queueCounter({
    entity: LandlordIntroRequest,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :introRequestStatus`,
      parameters: { introRequestStatus: LandlordIntroRequestStatus.Pending },
    }),
  }),

  [AdminQueueKey.LandlordSuggestions]: queueCounter({
    // A suggestion IS a landlord row created in `review`; there is no separate
    // submission table (`LandlordsService.suggest`).
    entity: Landlord,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :landlordStatus`,
      parameters: { landlordStatus: LandlordStatus.Review },
    }),
  }),

  [AdminQueueKey.Concerns]: queueCounter({
    entity: IntakeSubmission,
    waitingSince: 'createdAt',
    // A governance concern walks the richer worklist, so `reviewing` is still
    // open work: it has an outcome owed, not just a "seen" flag.
    waiting: (column) => ({
      sql:
        `${column('kind')} = :concernKind ` +
        `AND ${column('status')} IN (:...concernStatuses)`,
      parameters: {
        concernKind: 'governance_concern',
        concernStatuses: ['new', 'reviewing'],
      },
    }),
    // Three days for a concern, fourteen for most forms — `intake-sla.ts` owns
    // the numbers and stamped `due_at` from them at creation.
    deadline: (column) => ({ sql: column('dueAt'), parameters: {} }),
  }),

  [AdminQueueKey.Intakes]: queueCounter({
    entity: IntakeSubmission,
    waitingSince: 'createdAt',
    // Every other form only ever needs "seen and dealt with", which is
    // `reviewed`. The complement of the concern predicate above, so the two
    // queues partition the table and no row is counted twice.
    waiting: (column) => ({
      sql:
        `${column('kind')} <> :concernKind ` +
        `AND ${column('status')} = :newStatus`,
      parameters: { concernKind: 'governance_concern', newStatus: 'new' },
    }),
    deadline: (column) => ({ sql: column('dueAt'), parameters: {} }),
  }),

  [AdminQueueKey.LegalRequests]: queueCounter({
    entity: LegalRequest,
    waitingSince: 'createdAt',
    // The register has no status column: `outcome = pending` IS "we have not
    // answered this demand yet". A voided row is a record kept on purpose and
    // is owed nothing. Nothing announces into this queue — an admin enters the
    // row by hand when the demand arrives — so a standing count is the only
    // thing that can ever say a state demand is sitting unanswered.
    waiting: (column) => ({
      sql:
        `${column('outcome')} = :legalOutcome ` +
        `AND ${column('voidedAt')} IS NULL`,
      parameters: { legalOutcome: LegalRequestOutcome.Pending },
    }),
  }),

  [AdminQueueKey.HousingCoopJoinRequests]: queueCounter({
    entity: CoopJoinRequest,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :coopJoinRequestStatus`,
      parameters: { coopJoinRequestStatus: JoinRequestStatus.Pending },
    }),
  }),

  [AdminQueueKey.CommunityTagRequests]: queueCounter({
    entity: CommunityTagRequest,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :tagRequestStatus`,
      parameters: { tagRequestStatus: CommunityTagRequestStatus.Pending },
    }),
  }),

  [AdminQueueKey.ReadingGroupProposals]: queueCounter({
    entity: ReadingGroupProposal,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :proposalStatus`,
      parameters: { proposalStatus: ReadingGroupProposalStatus.Pending },
    }),
  }),

  [AdminQueueKey.SafeSpaceNominations]: queueCounter({
    entity: SafeSpaceNomination,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} IN (:...nominationStatuses)`,
      parameters: {
        nominationStatuses: [...SAFE_SPACE_NOMINATION_OPEN_STATUSES],
      },
    }),
    // The one derived clock here. The published copy promises acknowledgement
    // within 48 hours (`SAFE_SPACE_ACKNOWLEDGEMENT_HOURS`), and that promise
    // applies only while nobody has acknowledged: an `in_review` nomination is
    // collecting member visits on its own timetable and is not late.
    deadline: (column) => ({
      sql:
        `CASE WHEN ${column('status')} = :pendingNominationStatus ` +
        `THEN ${column('createdAt')} ` +
        `+ make_interval(hours => :acknowledgementHours) END`,
      parameters: {
        pendingNominationStatus: 'pending',
        acknowledgementHours: SAFE_SPACE_ACKNOWLEDGEMENT_HOURS,
      },
    }),
  }),

  [AdminQueueKey.SafeSpaceFlags]: queueCounter({
    entity: SafeSpaceFlag,
    waitingSince: 'createdAt',
    // The entity's own definition of open, and the predicate its partial unique
    // index is built on.
    waiting: (column) => ({
      sql:
        `${column('withdrawnAt')} IS NULL ` +
        `AND ${column('resolvedAt')} IS NULL`,
      parameters: {},
    }),
  }),

  [AdminQueueKey.ListingSubmissions]: queueCounter({
    entity: Listing,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :listingStatus`,
      parameters: { listingStatus: ListingStatus.Review },
    }),
  }),

  [AdminQueueKey.ListingClaims]: queueCounter({
    entity: ListingClaim,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :listingClaimStatus`,
      parameters: { listingClaimStatus: ListingClaimStatus.Pending },
    }),
  }),

  [AdminQueueKey.ListingEditSuggestions]: queueCounter({
    entity: ListingEditSuggestion,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :editSuggestionStatus`,
      parameters: {
        editSuggestionStatus: ListingEditSuggestionStatus.Pending,
      },
    }),
  }),

  [AdminQueueKey.ResourceSuggestions]: queueCounter({
    entity: ResourceSuggestion,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :resourceSuggestionStatus`,
      parameters: {
        resourceSuggestionStatus: ResourceSuggestionStatus.Pending,
      },
    }),
  }),

  [AdminQueueKey.MagazineSubmissions]: queueCounter({
    entity: MagazineStorySubmission,
    waitingSince: 'createdAt',
    // The two states the desk has not spoken on, minus anything the member
    // pulled back — `AdminStorySubmissionsService` filters the queue on
    // `withdrawnAt IS NULL` for the same reason.
    waiting: (column) => ({
      sql:
        `${column('status')} IN (:...submissionStatuses) ` +
        `AND ${column('withdrawnAt')} IS NULL`,
      parameters: {
        submissionStatuses: [
          SubmissionStatus.Submitted,
          SubmissionStatus.InReview,
        ],
      },
    }),
  }),

  [AdminQueueKey.WriterApplications]: queueCounter({
    entity: MagazineWriterApplication,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :writerApplicationStatus`,
      parameters: {
        writerApplicationStatus: WriterApplicationStatus.Pending,
      },
    }),
  }),

  // NOT COUNTABLE, and deliberately not faked. `commission_interest` has no
  // triage column at all: id, member, commission, recipient, message,
  // created_at. There is no way to record that a staff member has answered one,
  // so every row ever written is indistinguishable from a row that landed this
  // morning. A total would be an ever-growing number that never falls, which
  // reads as a queue nobody is working and would train an operator to ignore
  // the one figure this console exists to make trustworthy. The console shows
  // "not tracked" until the entity gains a worked marker; see the handoff in
  // the build report.
  [AdminQueueKey.CommissionInterests]: null,

  [AdminQueueKey.PartnerApplications]: queueCounter({
    entity: Partner,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :partnerStatus`,
      parameters: { partnerStatus: PartnerStatus.Pending },
    }),
    deadline: (column) => ({ sql: column('dueAt'), parameters: {} }),
  }),

  [AdminQueueKey.ChangemakerNominations]: queueCounter({
    entity: ChangemakerNomination,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :nominationStatus`,
      parameters: { nominationStatus: ChangemakerNominationStatus.Pending },
    }),
  }),

  [AdminQueueKey.RoadmapIdeas]: queueCounter({
    entity: RoadmapIdea,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :roadmapIdeaStatus`,
      parameters: { roadmapIdeaStatus: RoadmapIdeaStatus.Pending },
    }),
  }),

  [AdminQueueKey.GuideReviews]: queueCounter({
    entity: Resource,
    waitingSince: 'createdAt',
    // `ResourceReviewSweeperService.findNewlyDue`'s two populations, WITHOUT
    // its `review_overdue_notified_on` filter: that column exists to stop the
    // daily bell repeating itself, and a guide that has already been announced
    // is still owed a read. A never-reviewed guide is withheld from the public
    // entirely, so it is owed one whether or not it has a due date.
    waiting: (column) => ({
      sql:
        `((${column('reviewDueOn')} IS NOT NULL ` +
        `AND ${column('reviewDueOn')} <= :${QUEUE_NOW_PARAMETER}) ` +
        `OR ${column('lastReviewedOn')} IS NULL)`,
      parameters: {},
    }),
    // A never-reviewed guide with no due date waits without being overdue: it
    // has missed no date, and inventing one would be a deadline the platform
    // never set.
    deadline: (column) => ({ sql: column('reviewDueOn'), parameters: {} }),
  }),
};

/**
 * The three queues that receive arrivals under their own notification type and
 * are therefore absent from `AdminQueueKey`. See `AdminExtraQueueKey`.
 */
export const ADMIN_EXTRA_QUEUE_COUNTERS: Record<
  AdminExtraQueueKey,
  AdminQueueCounter | null
> = {
  [AdminExtraQueueKey.Reports]: queueCounter({
    entity: Report,
    waitingSince: 'createdAt',
    // Exactly `ModerationService.computeCounts`'s "open": an escalated report
    // is a community moderator handing the decision to platform staff, so it is
    // outstanding staff work rather than a closed row.
    waiting: (column) => ({
      sql: `${column('status')} IN (:...reportStatuses)`,
      parameters: {
        reportStatuses: [ReportStatus.Open, ReportStatus.Escalated],
      },
    }),
    // Severity-derived at creation by `slaDueAtFor`: one hour for the emergency
    // band, seven days for the low one.
    deadline: (column) => ({ sql: column('slaDueAt'), parameters: {} }),
  }),

  [AdminExtraQueueKey.BanEvasionEscalations]: queueCounter({
    entity: BanEvasionEscalation,
    waitingSince: 'createdAt',
    waiting: (column) => ({
      sql: `${column('status')} = :escalationStatus`,
      parameters: { escalationStatus: BanEvasionEscalationStatus.Open },
    }),
  }),

  [AdminExtraQueueKey.CommunityOwnerReviewRequests]: queueCounter({
    entity: CommunityOwnerReviewRequest,
    waitingSince: 'createdAt',
    // `withdrawn` is the community taking it back, not staff answering it.
    waiting: (column) => ({
      sql: `${column('status')} = :ownerReviewStatus`,
      parameters: {
        ownerReviewStatus: CommunityOwnerReviewRequestStatus.Open,
      },
    }),
  }),
};

/** Every triage queue's counter, registry and extras in one lookup. */
export const ADMIN_TRIAGE_QUEUE_COUNTERS: Record<
  AdminTriageQueueKey,
  AdminQueueCounter | null
> = {
  ...ADMIN_REGISTRY_QUEUE_COUNTERS,
  ...ADMIN_EXTRA_QUEUE_COUNTERS,
};
