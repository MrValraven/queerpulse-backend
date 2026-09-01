/**
 * The shared "a member submitted something and is owed an answer" vocabulary
 * (PRD-48).
 *
 * ---------------------------------------------------------------------------
 * The defect this closes
 * ---------------------------------------------------------------------------
 * There was no shared primitive for an intake. Every submission surface on the
 * platform grew its own entity, its own status vocabulary and its own decision
 * endpoint, and whether the person who submitted ever heard back was decided
 * one intake at a time, by whoever built it. The result is that three separate
 * silent black holes had to be found separately, as three separate findings, in
 * a deep scan: a partner application (PRD-37), a barter proposal (PRD-43) and a
 * suggested resource (PRD-45) each ended in permanent silence, for the same
 * reason, with the same fix.
 *
 * So this file is the fix to the class rather than to the three instances. An
 * intake adopts it by mapping its own status vocabulary onto `SubmissionOutcome`
 * at its decision endpoint and calling `SubmissionDecisionNotifier.notifyDecided`
 * once. That is the whole integration.
 *
 * ---------------------------------------------------------------------------
 * WHY `SUBMISSION_KIND_NOTIFICATION` IS AN EXHAUSTIVE `Record`
 * ---------------------------------------------------------------------------
 * This is the point of the whole row, and the shape is taken directly from
 * `src/feed/content-sensitivity.ts`, which was written after a hand-curated list
 * sitting beside the taxonomy it mirrored drifted from it and cost members a
 * report band they were relying on.
 *
 * A hand-kept list of "intakes that notify" beside the enum of intakes would
 * drift the same way, and the drift would be invisible: somebody adds a fourth
 * kind, nobody remembers this file, and the fourth intake ships as a fourth
 * black hole. Because the config is `Record<SubmissionKind, ...>` and total, the
 * compiler owns the relationship instead:
 *
 *   - add a member to `SubmissionKind` and this file stops compiling until
 *     somebody decides what the submitter is told;
 *   - remove or rename one and it stops compiling too, rather than quietly
 *     keeping a config entry nothing can ever reach.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT IN `SubmissionKind`
 * ---------------------------------------------------------------------------
 * The intakes that ALREADY tell their submitter something are not folded in
 * here, and should not be: `volunteer_application_decided`,
 * `writer_application_approved`/`declined`,
 * `changemaker_nomination_approved`/`dismissed` and `intake_reviewed` each keep
 * their own `NotificationType`, their own shipped copy, and rows already sitting
 * in members' bells.
 *
 * Rewriting them onto this primitive would mean a data migration over live
 * notification rows and a full copy rewrite in two languages, to gain nothing a
 * member could see: those members already hear back, which is the only thing
 * PRD-48 is about. The cost is real and the benefit is tidiness. This paragraph
 * exists so the next reader does not re-litigate it.
 *
 * The right rule going forward: a NEW intake uses this primitive; an existing
 * one that already speaks is left alone.
 */

/**
 * Every intake that reports its outcome through the shared
 * `NotificationType.SubmissionDecided` row.
 *
 * The value is what lands on `payload.kind` and what the frontend's copy keys
 * off (`notifications:type.submission_decided.<kind>.<outcome>.*`), so a value
 * here is part of a shipped contract: renaming one orphans the copy and the
 * rows already written with the old string.
 */
export enum SubmissionKind {
  /**
   * An organisation applying to be listed as a QueerPulse partner
   * (`PartnersService`, decided in the admin partner console). PRD-37.
   */
  PartnerApplication = 'partner_application',
  /**
   * A member proposing a swap against somebody else's barter listing
   * (`BarterService`, decided by the listing's owner). PRD-43.
   *
   * The one kind here whose reviewer is another MEMBER rather than staff, which
   * is why the copy for it must not read as a platform verdict.
   */
  BarterProposal = 'barter_proposal',
  /**
   * A member suggesting an entry for the resources directory
   * (`ResourceSuggestionsService`, decided in the admin resource-suggestions
   * queue). PRD-45.
   */
  ResourceSuggestion = 'resource_suggestion',
}

/** Every kind, for iteration and for the exhaustiveness test. */
export const SUBMISSION_KINDS = Object.values(SubmissionKind);

/**
 * The three terminal outcomes every adopting intake maps its own status
 * vocabulary onto. THE MAPPING LIVES AT THE CALL SITE, deliberately: a barter
 * proposal's `withdrawn`, a partner application's `rejected` and a resource
 * suggestion's `merged` are that intake's own words, and only that intake knows
 * which of these three they mean.
 *
 * Three and not more. The member is being told one of exactly three things, and
 * a vocabulary with a fourth shade in it would be a vocabulary each intake
 * interprets differently, which is the failure this file exists to end.
 */
export enum SubmissionOutcome {
  /** Taken forward: published, approved, accepted, listed. */
  Accepted = 'accepted',
  /**
   * Not taken forward. Written plainly, with the reviewer's reason where one
   * was given, and never with an apology or a hint that it might yet change.
   */
  Declined = 'declined',
  /**
   * Closed without a verdict either way: a duplicate, a stale queue item, a
   * submission the intake itself withdrew or superseded.
   *
   * Its own outcome rather than a shade of `Declined` because telling somebody
   * they were turned down when they were not is a worse row than telling them
   * nothing, and because a member reading "declined" reasonably concludes a
   * person weighed it and said no.
   */
  Archived = 'archived',
}

/**
 * The `payload.source` values the frontend's deep-link builder can actually
 * resolve (`sourceHrefFromPayload` in
 * `queerpulse/src/features/notifications/api/notifications.adapters.ts`).
 *
 * Typed as a closed union rather than `string` so a config entry cannot claim a
 * destination the client has no branch for: writing an unknown `source` yields
 * no href at all, silently, and a bell row that looks clickable and is not is
 * worse than an honest text-only row.
 *
 * This mirrors a frontend file across a repo boundary with no mechanical link,
 * exactly as the frontend's own `NotificationKind` mirrors the backend enum.
 * Widening it means adding the branch there FIRST.
 */
export type SubmissionDeepLinkSource =
  | 'listing'
  | 'community'
  | 'event'
  | 'job'
  /**
   * The proposer's own half of the skill exchange, `/work/barter/mine`, which
   * lists the swaps they posted and the proposals they SENT, each with its
   * outcome. No slug: the page is the member's own and takes no parameter.
   */
  | 'barter'
  /**
   * The member's submissions index, `/account/submissions`, which answers
   * "what did I send in, and what happened to it?" across every intake. No
   * slug, same reason. This is PRD-48's member-facing half and the reason two
   * of the three kinds below can point somewhere at all.
   */
  | 'submission';

/** What the bell is allowed to say and where it is allowed to point, per kind. */
export interface SubmissionKindNotificationConfig {
  /**
   * The `payload.source` this kind's row is written with, or `null` when the
   * member has no page to be sent to.
   *
   * `null` is a real answer, which is why it is spelled out per kind below
   * rather than left implicit. `intake_reviewed` still takes it, and for a good
   * reason: linking a member back to the form they filled in reads as "fill
   * this in again", which is the opposite of what just happened. A destination
   * only earns a value here once it is a page ABOUT the submission.
   */
  readonly deepLinkSource: SubmissionDeepLinkSource | null;
  /**
   * Whether the reviewer's note rides on the bell for this kind.
   *
   * `true` where the note is the substance of the answer and the member should
   * be able to read it wherever the answer reaches them. A verdict with its
   * reason withheld until the member goes and looks it up is a verdict they
   * first meet as a bare refusal, and QueerPulse sends no email, so the bell
   * and the submissions index are the only two places it can ever appear.
   * Carrying it in both costs nothing and means the row is complete on its own.
   *
   * `false` is for a kind whose note genuinely belongs somewhere else, which is
   * the `StorySubmissionDecided` precedent: a full editorial critique is a
   * document, not a notification line, so its tracker card holds it and the
   * bell carries only the verdict. Flipping this flag makes
   * `SubmissionDecisionNotifier` drop the note before it is ever written.
   */
  readonly isReviewNoteDelivered: boolean;
}

/**
 * Every submission kind, configured. EXHAUSTIVE BY TYPE: see the module
 * docstring for why that is the entire point of this shape, and
 * `src/feed/content-sensitivity.ts` for the same reasoning written down after
 * the drift it prevents had already happened once on this platform.
 */
export const SUBMISSION_KIND_NOTIFICATION: Record<
  SubmissionKind,
  SubmissionKindNotificationConfig
> = {
  // The applicant's own record of this application now lives on their
  // submissions index at /account/submissions, alongside the decision and the
  // partnerships team's reason. That is a page ABOUT the application, so it is
  // a fair destination; the apply form at /about/partners/apply never was, and
  // sending an applicant back to it after a decision would still read as an
  // invitation to apply again.
  [SubmissionKind.PartnerApplication]: {
    deepLinkSource: 'submission',
    isReviewNoteDelivered: true,
  },
  // The proposer's own view of a swap proposal lives at /work/barter/mine,
  // which holds the listing it was made against and the thread it opened, so it
  // says more about this proposal than the generic index does. The frontend
  // adapter resolves `barter` to exactly that page.
  [SubmissionKind.BarterProposal]: {
    deepLinkSource: 'barter',
    isReviewNoteDelivered: true,
  },
  // Same destination as the partner application, and for the same reason: the
  // suggestion itself is on the submissions index with its decision. It matters
  // most for this kind, because an `archived` suggestion is closed with no
  // verdict and emits no notification at all, so the index is the only place
  // that state is ever visible.
  [SubmissionKind.ResourceSuggestion]: {
    deepLinkSource: 'submission',
    isReviewNoteDelivered: true,
  },
};
