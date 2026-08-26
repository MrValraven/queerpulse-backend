import { RemovalKind } from './entities/removed-account-signal.entity';

/**
 * The wire shape of a ban-evasion assessment, plus the scoring that produces
 * it. Pure functions and plain interfaces only, so the weighting can be read
 * and tested without a database.
 *
 * The vocabulary matches the join-request queue's existing confidence-tiered
 * flags (`membership/join-request-flags.ts`): stable snake_case keys, resolved
 * to human copy by the frontend catalogue. A signal is something for a reviewer
 * to check. Nothing here denies anyone anything.
 */

/**
 * Every correlation this module can draw, each one a fact about a SPECIFIC
 * removed account rather than an impression about the applicant.
 */
export type BanEvasionSignalKind =
  /** The sign-in identifier is the one a removed account signed in with. */
  | 'sign_in_identifier_match'
  /** The address on this application is the one a removed account applied on. */
  | 'intake_contact_match'
  /** The stated name matches the one a removed account stated. */
  | 'stated_details_match'
  /** The member who invited this account was themselves removed. */
  | 'inviter_removed'
  /** The member who invited this account also invited a removed account. */
  | 'inviter_of_removed_account'
  /** The member named as a reference was themselves removed. */
  | 'reference_removed'
  /** The member named as a reference vouched for a removed account before. */
  | 'reference_of_removed_account';

/**
 * How loudly a reviewer should be asked to look. Deliberately four values with
 * `none` included, so the absence of a signal is a stated result rather than an
 * empty response the client has to interpret.
 */
export type BanEvasionTier = 'none' | 'low' | 'medium' | 'high';

/**
 * Weight per signal. An identifier match is worth far more than a name match,
 * because plenty of unrelated people share a name and nobody shares a peppered
 * digest of an address by accident.
 *
 * Nothing below reaches `high` on its own except an identifier match. Lineage
 * on its own lands at `medium` at most: an inviter whose past guest was removed
 * has done nothing wrong, and the reviewer is being asked to look, never told
 * what happened.
 */
export const BAN_EVASION_SIGNAL_WEIGHTS: Record<BanEvasionSignalKind, number> =
  {
    sign_in_identifier_match: 70,
    intake_contact_match: 50,
    inviter_removed: 35,
    reference_removed: 35,
    inviter_of_removed_account: 20,
    reference_of_removed_account: 20,
    stated_details_match: 15,
  };

const HIGH_TIER_SCORE = 60;
const MEDIUM_TIER_SCORE = 30;

/** Turn a total weight into the tier a reviewer sees. */
export function tierForScore(score: number): BanEvasionTier {
  if (score >= HIGH_TIER_SCORE) return 'high';
  if (score >= MEDIUM_TIER_SCORE) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

/**
 * One reason, tied to one removed account. The removed account is named when it
 * still exists so the reviewer can go and read it; once erased, only the date
 * and the kind of removal remain, which is exactly the trade this module makes.
 */
export interface BanEvasionSignalDTO {
  kind: BanEvasionSignalKind;
  removalKind: RemovalKind;
  /** ISO timestamp of the removal. */
  removedAt: string;
  /** Null once the removed account has been erased. */
  removedAccountName: string | null;
  removedAccountSlug: string | null;
  /** Name of the community for a community ban; null for a platform ban. */
  communityName: string | null;
}

/** The assessment of one join request or one account. */
export interface BanEvasionAssessmentDTO {
  /** The join-request id or user id this assessment is about. */
  subjectId: string;
  tier: BanEvasionTier;
  /** The summed weight behind the tier, so staff can see why it moved. */
  score: number;
  signals: BanEvasionSignalDTO[];
}

/**
 * Sum the weights of a set of signals, counting each KIND once however many
 * removed accounts produced it. Three inviter-lineage hits are one reason a
 * reviewer should look, not triple the certainty.
 */
export function scoreSignals(signals: readonly BanEvasionSignalDTO[]): number {
  const countedKinds = new Set<BanEvasionSignalKind>();
  let total = 0;
  for (const signal of signals) {
    if (countedKinds.has(signal.kind)) continue;
    countedKinds.add(signal.kind);
    total += BAN_EVASION_SIGNAL_WEIGHTS[signal.kind];
  }
  return total;
}

/** Compose the assessment for a subject from the signals found for it. */
export function toBanEvasionAssessment(
  subjectId: string,
  signals: BanEvasionSignalDTO[],
): BanEvasionAssessmentDTO {
  const score = scoreSignals(signals);
  return { subjectId, tier: tierForScore(score), score, signals };
}
