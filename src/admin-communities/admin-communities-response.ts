import { MemberRef } from '../common/member-ref';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import { ReportSeverity } from '../reports/entities/report.entity';

export type BadgeTone = 'plum' | 'coral' | 'jade' | 'violet' | 'amber';
export type Visibility = 'private' | 'public' | 'network';
export type ActivityLabel =
  'Quiet' | 'Growing' | 'Steady' | 'Active' | 'High' | 'Busy';

/**
 * Everything the health math needs about one community, already aggregated by
 * the service. Kept as a plain value object so the scoring below stays pure and
 * directly unit-testable without a database.
 */
export interface CommunityAggregates {
  memberCount: number;
  activeThisWeek: number;
  postsThisWeek: number;
  /** Eight weekly buckets of posts + replies, oldest first. */
  weeklyActivity: number[];
  totalReportCount: number;
  openReportCount: number;
  overdueOpenReportCount: number;
  /** Open reports weighted by severity — see SEVERITY_WEIGHT. */
  severityWeightedOpenLoad: number;
  /** Days since the community was created. Used to give a brand-new
   *  community a grace period before its health score can flag it or sort
   *  it as struggling — see NEW_COMMUNITY_GRACE_PERIOD_DAYS. */
  communityAgeInDays: number;
}

export interface HealthBreakdown {
  memberActivity: number;
  reportResolution: number;
  /**
   * Always null. There is no sentiment data anywhere in the platform yet; the
   * signal is kept in the shape so the admin UI can say "not measured yet"
   * rather than silently presenting a three-signal score as a four-signal one.
   */
  memberSentiment: number | null;
  safetyLoad: number;
}

export interface AdminCommunityCardDTO {
  slug: string;
  name: string;
  initials: string;
  tone: BadgeTone;
  tag: string;
  memberCount: number;
  activityLabel: ActivityLabel;
  activePercentage: number;
  openReportCount: number;
  healthScore: number;
  healthBreakdown: HealthBreakdown;
  activitySparkline: number[];
  needsSupport: boolean;
}

export interface AdminCommunityModeratorDTO {
  slug: string;
  name: string;
  initials: string;
  role: 'owner' | 'mod';
  joinedAt: string;
}

export interface AdminCommunityQueueItemDTO {
  id: string;
  severity: ReportSeverity;
  reasonCode: string;
  detail: string | null;
  status: string;
  overdue: boolean;
  createdAt: string;
}

export interface AdminCommunityDetailDTO extends AdminCommunityCardDTO {
  description: string;
  foundedAt: string;
  visibility: Visibility;
  resolvedPercentage: number;
  moderators: AdminCommunityModeratorDTO[];
  scopedQueue: AdminCommunityQueueItemDTO[];
}

const SEVERITY_WEIGHT: Record<ReportSeverity, number> = {
  [ReportSeverity.Emergency]: 8,
  [ReportSeverity.High]: 4,
  [ReportSeverity.Medium]: 2,
  [ReportSeverity.Low]: 1,
};

/** Weighted open-report load per member, scaled so ~1 weighted point per 5
 *  members reads as fully strained. */
const SAFETY_LOAD_SCALE = 500;
/** Each overdue open report costs this many points on top of its severity. */
const OVERDUE_PENALTY = 6;

const BADGE_TONES: BadgeTone[] = ['plum', 'coral', 'jade', 'violet', 'amber'];

export function severityWeight(severity: ReportSeverity): number {
  return SEVERITY_WEIGHT[severity] ?? 1;
}

function clampToPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function computeHealthBreakdown(
  aggregates: CommunityAggregates,
): HealthBreakdown {
  const memberActivity =
    aggregates.memberCount > 0
      ? clampToPercentage(
          (100 * aggregates.activeThisWeek) / aggregates.memberCount,
        )
      : 0;

  // No reports at all is a healthy state, not missing data.
  const reportResolution =
    aggregates.totalReportCount > 0
      ? clampToPercentage(
          (100 * (aggregates.totalReportCount - aggregates.openReportCount)) /
            aggregates.totalReportCount,
        )
      : 100;

  const loadPerMember =
    aggregates.memberCount > 0
      ? aggregates.severityWeightedOpenLoad / aggregates.memberCount
      : aggregates.severityWeightedOpenLoad;
  const safetyLoad = clampToPercentage(
    100 -
      loadPerMember * SAFETY_LOAD_SCALE -
      aggregates.overdueOpenReportCount * OVERDUE_PENALTY,
  );

  return {
    memberActivity,
    reportResolution,
    memberSentiment: null,
    safetyLoad,
  };
}

/** Mean of the signals that actually have data. A null signal is skipped
 *  entirely rather than counted as zero. */
export function computeHealthScore(breakdown: HealthBreakdown): number {
  const measuredSignals = [
    breakdown.memberActivity,
    breakdown.reportResolution,
    breakdown.memberSentiment,
    breakdown.safetyLoad,
  ].filter((signal): signal is number => signal !== null);

  if (measuredSignals.length === 0) return 0;
  const total = measuredSignals.reduce((sum, signal) => sum + signal, 0);
  return Math.round(total / measuredSignals.length);
}

export function activityLabelFor(
  aggregates: CommunityAggregates,
): ActivityLabel {
  if (aggregates.postsThisWeek === 0) return 'Quiet';
  const participation =
    aggregates.memberCount > 0
      ? aggregates.activeThisWeek / aggregates.memberCount
      : 0;
  if (aggregates.postsThisWeek >= 80 && participation >= 0.5) return 'High';
  if (aggregates.postsThisWeek >= 80) return 'Busy';
  if (aggregates.postsThisWeek >= 30) return 'Active';
  if (aggregates.postsThisWeek >= 10) return 'Steady';
  return 'Growing';
}

export function initialsFor(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) return '··';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic tone from the slug, so a community keeps the same colour
 *  across requests without storing one. */
export function toneFor(slug: string): BadgeTone {
  let hash = 0;
  for (
    let characterIndex = 0;
    characterIndex < slug.length;
    characterIndex += 1
  ) {
    hash = (hash * 31 + slug.charCodeAt(characterIndex)) % 1_000_003;
  }
  return BADGE_TONES[hash % BADGE_TONES.length];
}

const VISIBILITY_BY_ACCESS_TIER: Record<AccessTier, Visibility> = {
  [AccessTier.Public]: 'public',
  [AccessTier.Request]: 'network',
  [AccessTier.Invite]: 'network',
  [AccessTier.Private]: 'private',
};

const TYPE_LABEL: Record<CommunityType, string> = {
  [CommunityType.Social]: 'Social',
  [CommunityType.Arts]: 'Arts',
  [CommunityType.Activism]: 'Activism',
  [CommunityType.Support]: 'Support',
  [CommunityType.Sports]: 'Sports',
  [CommunityType.Professional]: 'Professional',
};

// Exported so tests can reference the real thresholds instead of
// re-hardcoding magic numbers that could silently drift out of sync.
export const SUPPORT_HEALTH_THRESHOLD = 78;
export const SUPPORT_OPEN_REPORT_THRESHOLD = 5;

/**
 * A community younger than this has not had time to accumulate the
 * membership and activity data the health formula depends on: with one
 * member and no posts, `memberActivity` is 0 by construction (nobody has had
 * a chance to be "active this week" yet), which alone drags a brand-new,
 * perfectly calm community below SUPPORT_HEALTH_THRESHOLD on day one. Two
 * weeks is roughly the time a community needs to pick up enough members and
 * posts for the memberActivity and safetyLoad ratios to reflect something
 * real rather than a single early data point.
 *
 * This grace period ONLY suppresses the low-health-score trigger. It never
 * suppresses the open-report trigger below — a community with a real, open
 * incident is an emergency on day one just as much as on day one thousand.
 */
export const NEW_COMMUNITY_GRACE_PERIOD_DAYS = 14;

function hasReportEmergency(aggregates: CommunityAggregates): boolean {
  return aggregates.openReportCount >= SUPPORT_OPEN_REPORT_THRESHOLD;
}

function isEstablishedCommunity(aggregates: CommunityAggregates): boolean {
  return aggregates.communityAgeInDays >= NEW_COMMUNITY_GRACE_PERIOD_DAYS;
}

export function toAdminCommunityCard(
  community: Community,
  aggregates: CommunityAggregates,
): AdminCommunityCardDTO {
  const healthBreakdown = computeHealthBreakdown(aggregates);
  const healthScore = computeHealthScore(healthBreakdown);
  const activePercentage = healthBreakdown.memberActivity;

  // A low health score only means something once a community has had time
  // to accumulate real activity (see NEW_COMMUNITY_GRACE_PERIOD_DAYS). An
  // open-report emergency is real regardless of age, so it always flags.
  const needsSupport =
    hasReportEmergency(aggregates) ||
    (isEstablishedCommunity(aggregates) &&
      healthScore < SUPPORT_HEALTH_THRESHOLD);

  return {
    slug: community.slug,
    name: community.name,
    initials: initialsFor(community.name),
    tone: toneFor(community.slug),
    tag: `${TYPE_LABEL[community.type]} · ${community.accessTier}`,
    memberCount: aggregates.memberCount,
    activityLabel: activityLabelFor(aggregates),
    activePercentage,
    openReportCount: aggregates.openReportCount,
    healthScore,
    healthBreakdown,
    activitySparkline: aggregates.weeklyActivity,
    needsSupport,
  };
}

export function toAdminCommunityDetail(
  community: Community,
  aggregates: CommunityAggregates,
  moderators: AdminCommunityModeratorDTO[],
  scopedQueue: AdminCommunityQueueItemDTO[],
): AdminCommunityDetailDTO {
  const communityCard = toAdminCommunityCard(community, aggregates);
  const resolvedPercentage = communityCard.healthBreakdown.reportResolution;

  return {
    ...communityCard,
    description: community.purpose,
    foundedAt: community.createdAt.toISOString(),
    visibility: VISIBILITY_BY_ACCESS_TIER[community.accessTier],
    resolvedPercentage,
    moderators,
    scopedQueue,
  };
}

export function toAdminModerator(
  memberRef: MemberRef,
  role: 'owner' | 'mod',
  joinedAt: Date,
): AdminCommunityModeratorDTO {
  return {
    slug: memberRef.slug,
    name: `${memberRef.firstName} ${memberRef.lastName}`.trim(),
    initials: initialsFor(`${memberRef.firstName} ${memberRef.lastName}`),
    role,
    joinedAt: joinedAt.toISOString(),
  };
}
