import { UserRole } from '../users/entities/user.entity';
import { standingFor } from './admin-trust-network-response';
import type { Standing } from './admin-trust-network-response';
import { detectRings } from './admin-trust-network-ring';
import type {
  RingCandidateEdge,
  RingCandidateNode,
} from './admin-trust-network-ring';

export type AccountKind = 'founder' | 'staff' | 'system' | 'member';
export type WeakVoucherReason = 'new' | 'flagged' | 'ring';
export type TrustCaseKind = 'ring' | 'isolated' | 'flagged';

/** The "new account" window never grows past this many days. */
export const NEW_ACCOUNT_MAX_DAYS = 30;
/** On a young platform the window is this share of the platform's age, so the
 *  first wave of members does not all read as new. */
export const NEW_ACCOUNT_PLATFORM_SHARE = 0.25;
/** The window never shrinks below one day. */
export const NEW_ACCOUNT_MIN_DAYS = 1;
/** An account with no inviter that joined within this many days of the
 *  platform's first member is a founder. */
export const FOUNDING_WINDOW_DAYS = 30;

export interface AssessmentMemberInput {
  userId: string;
  slug: string;
  name: string;
  verified: boolean;
  joinedAt: Date;
  role: UserRole;
  isSystem: boolean;
  isSuspended: boolean;
  /** Paused account or deletion grace period (`UserStatus.Deactivated`).
   *  Handled like a suspended account for cases, isolation and ring
   *  candidacy; it can still appear as a voucher. */
  isDeactivated: boolean;
  invitedByUserId: string | null;
  openReportCount: number;
}

export interface AssessmentVouchInput {
  voucherId: string;
  voucheeId: string;
  withdrawn: boolean;
}

export interface MemberAssessment {
  accountKind: AccountKind;
  standing: Standing;
  ringId: string | null;
  isolatedBy: { userId: string; reason: WeakVoucherReason }[];
  trackRecord: { vouchesGiven: number; laterFlaggedCount: number };
  activeInboundCount: number;
  activeOutboundCount: number;
}

export interface RingAssessment {
  id: string;
  memberUserIds: string[];
  firstJoinedAt: Date;
  lastJoinedAt: Date;
  sharedVoucherUserIds: string[];
}

export interface CaseAssessment {
  id: string;
  kind: TrustCaseKind;
  subjectUserId: string;
  ringId: string | null;
  memberCount: number;
  weakVoucherCount: number;
  openReportCount: number;
  windowHours: number | null;
  score: number;
}

export interface TrustAssessment {
  generatedAt: Date;
  platformStartedAt: Date;
  newAccountWindowDays: number;
  /** Every assessed member, by userId. */
  members: Map<string, AssessmentMemberInput>;
  byUserId: Map<string, MemberAssessment>;
  rings: RingAssessment[];
  /** Sorted: score desc, newer subject joinedAt first, then slug asc. */
  cases: CaseAssessment[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const RING_CASE_BASE_SCORE = 3000;
const FLAGGED_CASE_BASE_SCORE = 2000;
const FLAGGED_CASE_REPORT_WEIGHT = 10;
const ISOLATED_CASE_BASE_SCORE = 1000;

/** `isolatedBy` order: the strongest reason first. */
const WEAK_REASON_ORDER: Record<WeakVoucherReason, number> = {
  ring: 0,
  flagged: 1,
  new: 2,
};

/** Plain code-unit order for slugs and names, so ring ids, sort orders and
 *  tie-breaks never depend on the server's locale. */
export function compareCodeUnits(
  firstText: string,
  secondText: string,
): number {
  if (firstText < secondText) return -1;
  if (firstText > secondText) return 1;
  return 0;
}

/** Suspended or deactivated accounts get neither a case, isolation nor ring
 *  candidacy. They can still appear as someone else's voucher. */
function isInactive(member: AssessmentMemberInput): boolean {
  return member.isSuspended || member.isDeactivated;
}

/** Earliest joinedAt among non-system members. Falls back to the earliest
 *  member of any kind, then to `now` for an empty platform. */
function platformStartFor(members: AssessmentMemberInput[], now: Date): Date {
  const humanMembers = members.filter((member) => !member.isSystem);
  const pool = humanMembers.length > 0 ? humanMembers : members;
  let earliestTime = Number.POSITIVE_INFINITY;
  for (const member of pool) {
    earliestTime = Math.min(earliestTime, member.joinedAt.getTime());
  }
  return Number.isFinite(earliestTime) ? new Date(earliestTime) : now;
}

/** clamp(min(30, 0.25 x platform age in days), 1, 30), whole days. */
function newAccountWindowDaysFor(platformStartedAt: Date, now: Date): number {
  const platformAgeDays =
    (now.getTime() - platformStartedAt.getTime()) / DAY_MS;
  const scaledDays = Math.floor(
    Math.min(
      NEW_ACCOUNT_MAX_DAYS,
      NEW_ACCOUNT_PLATFORM_SHARE * Math.max(0, platformAgeDays),
    ),
  );
  return Math.max(NEW_ACCOUNT_MIN_DAYS, scaledDays);
}

/** Precedence: system, staff, founder, member. */
function accountKindFor(
  member: AssessmentMemberInput,
  platformStartedAt: Date,
): AccountKind {
  if (member.isSystem) return 'system';
  if (member.role === UserRole.Admin || member.role === UserRole.Moderator) {
    return 'staff';
  }
  const daysAfterStart =
    (member.joinedAt.getTime() - platformStartedAt.getTime()) / DAY_MS;
  if (
    member.invitedByUserId === null &&
    daysAfterStart <= FOUNDING_WINDOW_DAYS
  ) {
    return 'founder';
  }
  return 'member';
}

/** Vouches between two known members, one entry per (voucher, vouchee) pair.
 *  A pair counts as active when any of its rows is active. Self-vouches are
 *  dropped. */
function knownVouchPairs(
  vouches: AssessmentVouchInput[],
  memberById: Map<string, AssessmentMemberInput>,
): AssessmentVouchInput[] {
  const pairByKey = new Map<string, AssessmentVouchInput>();
  for (const vouch of vouches) {
    if (vouch.voucherId === vouch.voucheeId) continue;
    if (!memberById.has(vouch.voucherId) || !memberById.has(vouch.voucheeId)) {
      continue;
    }
    const pairKey = `${vouch.voucherId}>${vouch.voucheeId}`;
    const existingPair = pairByKey.get(pairKey);
    if (existingPair) {
      existingPair.withdrawn = existingPair.withdrawn && vouch.withdrawn;
    } else {
      pairByKey.set(pairKey, { ...vouch });
    }
  }
  return [...pairByKey.values()];
}

function pushToList(
  listById: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const list = listById.get(key);
  if (list) list.push(value);
  else listById.set(key, [value]);
}

function buildRing(
  ringMemberIds: Set<string>,
  activePairs: AssessmentVouchInput[],
  memberById: Map<string, AssessmentMemberInput>,
): RingAssessment {
  const ringMembers = [...ringMemberIds]
    .map((userId) => memberById.get(userId))
    .filter((member): member is AssessmentMemberInput => member !== undefined)
    .sort((first, second) => compareCodeUnits(first.slug, second.slug));
  const joinTimes = ringMembers.map((member) => member.joinedAt.getTime());

  // Outside members whose active vouches reach 2+ ring members.
  const ringVoucheesByOutsideVoucher = new Map<string, Set<string>>();
  for (const pair of activePairs) {
    if (!ringMemberIds.has(pair.voucheeId)) continue;
    if (ringMemberIds.has(pair.voucherId)) continue;
    const vouchees =
      ringVoucheesByOutsideVoucher.get(pair.voucherId) ?? new Set<string>();
    vouchees.add(pair.voucheeId);
    ringVoucheesByOutsideVoucher.set(pair.voucherId, vouchees);
  }
  const sharedVoucherUserIds = [...ringVoucheesByOutsideVoucher.entries()]
    .filter(([, vouchees]) => vouchees.size >= 2)
    .map(([voucherId]) => voucherId)
    .sort((firstId, secondId) =>
      compareCodeUnits(
        memberById.get(firstId)?.slug ?? firstId,
        memberById.get(secondId)?.slug ?? secondId,
      ),
    );

  return {
    id: `ring:${ringMembers[0]?.slug ?? ''}`,
    memberUserIds: ringMembers.map((member) => member.userId),
    firstJoinedAt: new Date(Math.min(...joinTimes)),
    lastJoinedAt: new Date(Math.max(...joinTimes)),
    sharedVoucherUserIds,
  };
}

function compareCases(
  firstCase: CaseAssessment,
  secondCase: CaseAssessment,
  memberById: Map<string, AssessmentMemberInput>,
): number {
  if (firstCase.score !== secondCase.score) {
    return secondCase.score - firstCase.score;
  }
  const firstSubject = memberById.get(firstCase.subjectUserId);
  const secondSubject = memberById.get(secondCase.subjectUserId);
  const joinDifference =
    (secondSubject?.joinedAt.getTime() ?? 0) -
    (firstSubject?.joinedAt.getTime() ?? 0);
  if (joinDifference !== 0) return joinDifference;
  return compareCodeUnits(firstSubject?.slug ?? '', secondSubject?.slug ?? '');
}

/**
 * Platform-wide trust assessment (spec section 3): standing, account kind,
 * rings, isolation, track record, active vouch counts and the triage cases
 * for EVERY member. Pure: same inputs and `now`, same result.
 */
export function assessTrustNetwork(
  members: AssessmentMemberInput[],
  vouches: AssessmentVouchInput[],
  now: Date,
): TrustAssessment {
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const platformStartedAt = platformStartFor(members, now);
  const newAccountWindowDays = newAccountWindowDaysFor(platformStartedAt, now);

  const standingById = new Map<string, Standing>();
  const accountKindById = new Map<string, AccountKind>();
  for (const member of members) {
    standingById.set(
      member.userId,
      standingFor({
        suspended: member.isSuspended,
        frozen: member.isSuspended && member.openReportCount === 0,
        openReportCount: member.openReportCount,
        verified: member.verified,
      }),
    );
    accountKindById.set(
      member.userId,
      accountKindFor(member, platformStartedAt),
    );
  }
  const isExempt = (userId: string): boolean =>
    accountKindById.get(userId) !== 'member';
  const isInactiveById = (userId: string): boolean => {
    const member = memberById.get(userId);
    return member === undefined || isInactive(member);
  };

  const vouchPairs = knownVouchPairs(vouches, memberById);
  const activePairs = vouchPairs.filter((pair) => !pair.withdrawn);

  // Rings: candidates are unverified accounts that are neither exempt nor
  // inactive (suspended or deactivated).
  const ringNodes: RingCandidateNode[] = members.map((member) => ({
    id: member.userId,
    verified: member.verified,
    standing: standingById.get(member.userId) ?? 'new',
  }));
  const ringEdges: RingCandidateEdge[] = vouchPairs.map((pair) => ({
    from: pair.voucherId,
    to: pair.voucheeId,
    withdrawn: pair.withdrawn,
  }));
  const rings = detectRings(
    ringNodes,
    ringEdges,
    (node) => !node.verified && !isExempt(node.id) && !isInactiveById(node.id),
  )
    .map((ringMemberIds) => buildRing(ringMemberIds, activePairs, memberById))
    .sort((firstRing, secondRing) =>
      compareCodeUnits(firstRing.id, secondRing.id),
    );
  const ringIdByUserId = new Map<string, string>();
  for (const ring of rings) {
    for (const userId of ring.memberUserIds)
      ringIdByUserId.set(userId, ring.id);
  }

  const activeVoucherIdsByVouchee = new Map<string, string[]>();
  const activeVoucheeIdsByVoucher = new Map<string, string[]>();
  for (const pair of activePairs) {
    pushToList(activeVoucherIdsByVouchee, pair.voucheeId, pair.voucherId);
    pushToList(activeVoucheeIdsByVoucher, pair.voucherId, pair.voucheeId);
  }
  const everVoucheeIdsByVoucher = new Map<string, string[]>();
  for (const pair of vouchPairs) {
    pushToList(everVoucheeIdsByVoucher, pair.voucherId, pair.voucheeId);
  }

  const weakReasonFor = (voucherId: string): WeakVoucherReason | null => {
    const voucher = memberById.get(voucherId);
    if (!voucher || isExempt(voucherId)) return null;
    if (ringIdByUserId.has(voucherId)) return 'ring';
    if (standingById.get(voucherId) === 'flagged') return 'flagged';
    const accountAgeDays =
      (now.getTime() - voucher.joinedAt.getTime()) / DAY_MS;
    if (!voucher.verified && accountAgeDays < newAccountWindowDays)
      return 'new';
    return null;
  };

  // A ring member's ring case already explains its weak vouchers, so the
  // isolation list stays empty for every ring member.
  const isolatedByFor = (
    member: AssessmentMemberInput,
  ): MemberAssessment['isolatedBy'] => {
    if (isInactive(member) || isExempt(member.userId)) return [];
    if (ringIdByUserId.has(member.userId)) return [];
    const voucherIds = activeVoucherIdsByVouchee.get(member.userId) ?? [];
    if (voucherIds.length === 0) return [];
    const weakVouchers: MemberAssessment['isolatedBy'] = [];
    for (const voucherId of voucherIds) {
      const reason = weakReasonFor(voucherId);
      if (reason === null) return [];
      weakVouchers.push({ userId: voucherId, reason });
    }
    return weakVouchers.sort((first, second) => {
      const reasonDifference =
        WEAK_REASON_ORDER[first.reason] - WEAK_REASON_ORDER[second.reason];
      if (reasonDifference !== 0) return reasonDifference;
      const firstName = memberById.get(first.userId)?.name ?? '';
      const secondName = memberById.get(second.userId)?.name ?? '';
      return (
        compareCodeUnits(firstName, secondName) ||
        compareCodeUnits(
          memberById.get(first.userId)?.slug ?? first.userId,
          memberById.get(second.userId)?.slug ?? second.userId,
        )
      );
    });
  };

  const byUserId = new Map<string, MemberAssessment>();
  for (const member of members) {
    const everVoucheeIds = everVoucheeIdsByVoucher.get(member.userId) ?? [];
    byUserId.set(member.userId, {
      accountKind: accountKindById.get(member.userId) ?? 'member',
      standing: standingById.get(member.userId) ?? 'new',
      ringId: ringIdByUserId.get(member.userId) ?? null,
      isolatedBy: isolatedByFor(member),
      trackRecord: {
        vouchesGiven: everVoucheeIds.length,
        laterFlaggedCount: everVoucheeIds.filter(
          (voucheeId) =>
            memberById.get(voucheeId)?.isSuspended === true ||
            standingById.get(voucheeId) === 'flagged',
        ).length,
      },
      activeInboundCount:
        activeVoucherIdsByVouchee.get(member.userId)?.length ?? 0,
      activeOutboundCount:
        activeVoucheeIdsByVoucher.get(member.userId)?.length ?? 0,
    });
  }

  // Cases: one per member at most, precedence ring > flagged > isolated.
  // Suspended members are already actioned and deactivated ones are away,
  // so neither gets a case.
  const cases: CaseAssessment[] = [];
  const memberIdsWithCase = new Set<string>();
  for (const ring of rings) {
    const ringMembers = ring.memberUserIds
      .map((userId) => memberById.get(userId))
      .filter(
        (member): member is AssessmentMemberInput => member !== undefined,
      );
    const seedMember = [...ringMembers].sort(
      (first, second) =>
        first.joinedAt.getTime() - second.joinedAt.getTime() ||
        compareCodeUnits(first.slug, second.slug),
    )[0];
    if (!seedMember) continue;
    for (const ringMember of ringMembers)
      memberIdsWithCase.add(ringMember.userId);
    cases.push({
      id: ring.id,
      kind: 'ring',
      subjectUserId: seedMember.userId,
      ringId: ring.id,
      memberCount: ringMembers.length,
      weakVoucherCount: 0,
      openReportCount: ringMembers.reduce(
        (total, ringMember) => total + ringMember.openReportCount,
        0,
      ),
      windowHours: Math.ceil(
        (ring.lastJoinedAt.getTime() - ring.firstJoinedAt.getTime()) / HOUR_MS,
      ),
      score: RING_CASE_BASE_SCORE + ringMembers.length,
    });
  }
  for (const member of members) {
    if (isInactive(member) || memberIdsWithCase.has(member.userId)) continue;
    const assessment = byUserId.get(member.userId);
    if (!assessment) continue;
    if (assessment.standing === 'flagged') {
      cases.push({
        id: `flagged:${member.slug}`,
        kind: 'flagged',
        subjectUserId: member.userId,
        ringId: null,
        memberCount: 1,
        weakVoucherCount: 0,
        openReportCount: member.openReportCount,
        windowHours: null,
        score:
          FLAGGED_CASE_BASE_SCORE +
          FLAGGED_CASE_REPORT_WEIGHT * member.openReportCount,
      });
    } else if (assessment.isolatedBy.length > 0) {
      cases.push({
        id: `isolated:${member.slug}`,
        kind: 'isolated',
        subjectUserId: member.userId,
        ringId: null,
        memberCount: 1,
        weakVoucherCount: assessment.isolatedBy.length,
        openReportCount: member.openReportCount,
        windowHours: null,
        score: ISOLATED_CASE_BASE_SCORE + assessment.isolatedBy.length,
      });
    }
  }
  cases.sort((firstCase, secondCase) =>
    compareCases(firstCase, secondCase, memberById),
  );

  return {
    generatedAt: now,
    platformStartedAt,
    newAccountWindowDays,
    members: memberById,
    byUserId,
    rings,
    cases,
  };
}
