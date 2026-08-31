import { MemberRef } from '../common/member-ref';
import { BanEvasionAssessmentDTO } from './ban-evasion-response';
import { BanEvasionEscalationStatus } from './entities/ban-evasion-escalation.entity';

/**
 * The wire shapes for the two community-scoped ban-evasion surfaces and for the
 * staff queue their escalations land in.
 *
 * THE PRINCIPLE THIS FILE ENCODES: the community moderator recognises, platform
 * staff investigates. Read `CommunityBanEvasionFlagDTO` below before adding a
 * field to it.
 */

/**
 * One join request, one bit.
 *
 * This is the whole of what a community's owner, co-owners and moderators are
 * told about an applicant's ban history, and it is intentionally the narrowest
 * shape this codebase can express. There is no confidence tier, no score, no
 * count of matched signals, no salted hash, no identifier, no name or slug of a
 * prior account, and no date. The community's staff cannot tell WHICH of their
 * own bans matched, only that one did.
 *
 * AND IT IS THIS COMMUNITY ONLY. A match against a ban from any other community
 * on the platform, or against a platform-level ban, answers `false` here. That
 * is deliberate and it is the point: a community moderator recognises people
 * they themselves barred, which is knowledge they already have. Somebody else's
 * ban is not theirs to be told about, and a cross-community picture is a
 * judgement platform staff make on the console where the full assessment lives.
 * `escalate` exists so a moderator who suspects more can ASK for that judgement
 * instead of being handed it.
 *
 * DO NOT WIDEN THIS. If a future reader wants a tier here, or the matched
 * signal, or "banned somewhere else", that is a product decision to re-take with
 * the privacy call it carries, not a field to add because the data is nearby.
 * The service behind this never builds the wide assessment in the first place,
 * so there is nothing here to strip and nothing to leak by accident.
 */
export interface CommunityBanEvasionFlagDTO {
  joinRequestId: string;
  /**
   * True when this applicant correlates with an account THIS community banned.
   * False for every other answer, including "matched, but only elsewhere on the
   * platform" and "nothing checked because no pepper is configured".
   */
  isMatchingBannedMember: boolean;
}

/**
 * One escalation as the community's own staff read it: what they get back when
 * they escalate, what they get back when they escalate a second time (the same
 * row, idempotently), and every row on
 * `GET /communities/:slug/join-requests/escalations`.
 *
 * SAME BOUNDARY AS THE FLAG ABOVE. This carries no part of the assessment, and
 * no part of what staff did with it: there is no `assessment`, no
 * `resolutionNote`, no `resolvedBy` and no `resolvedAt`. A community moderator
 * learns that they asked, and whether somebody has closed the question. What
 * staff found is a cross-community judgement, and handing it back to the
 * escalating moderator would deliver through the back door the exact picture
 * the one-bit badge exists to withhold. Those fields live on
 * `BanEvasionEscalationDTO`, which is staff-only.
 *
 * `status` is here for one concrete reason: without it a moderator who
 * escalated has no way to see that they did, so the triage screen offers the
 * button again on a case already sitting in front of staff. `resolved`
 * additionally tells them the question may be asked again, which is true,
 * because the one-open-per-join-request index is partial.
 *
 * The escalation is a question, and the answer lands with staff.
 */
export interface CommunityBanEvasionEscalationDTO {
  id: string;
  joinRequestId: string;
  status: BanEvasionEscalationStatus;
  /** ISO timestamp of when the escalation was raised. */
  createdAt: string;
  note: string | null;
}

/** Hand-map an escalation row to the community-facing shape. */
export function toCommunityBanEvasionEscalationDTO(escalation: {
  id: string;
  joinRequestId: string;
  status: BanEvasionEscalationStatus;
  createdAt: Date;
  note: string | null;
}): CommunityBanEvasionEscalationDTO {
  return {
    id: escalation.id,
    joinRequestId: escalation.joinRequestId,
    status: escalation.status,
    createdAt: escalation.createdAt.toISOString(),
    note: escalation.note,
  };
}

/**
 * One escalation as platform staff read it on `/admin/ban-evasion`, with the
 * FULL cross-community assessment of the applicant attached.
 *
 * The width here is the whole point of escalating: staff see the tier, the
 * score and every matched signal, across every community and the platform ban
 * list, which is exactly what the community moderator does not see.
 */
export interface BanEvasionEscalationDTO {
  id: string;
  status: BanEvasionEscalationStatus;
  /** ISO timestamp. */
  createdAt: string;
  note: string | null;
  communitySlug: string;
  communityName: string;
  joinRequestId: string;
  /** The applicant, when their account still exists. */
  subject: MemberRef | null;
  /** The moderator who escalated, when their account still exists. */
  raisedBy: MemberRef | null;
  /**
   * The full assessment of the applicant. Null when the applicant's account has
   * been erased, which leaves nothing to correlate.
   */
  assessment: BanEvasionAssessmentDTO | null;
  /** ISO timestamp, null while open. */
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolvedBy: MemberRef | null;
}
