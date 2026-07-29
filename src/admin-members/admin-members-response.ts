export type BadgeTone = 'plum' | 'coral' | 'jade' | 'violet' | 'amber';
export type ModerationState = 'under_review' | 'frozen' | 'limited';

const BADGE_TONES: BadgeTone[] = ['plum', 'coral', 'jade', 'violet', 'amber'];

export function initialsFor(firstName: string, lastName: string): string {
  const firstInitial = firstName.trim()[0] ?? '';
  const lastInitial = lastName.trim()[0] ?? '';
  return `${firstInitial}${lastInitial}`.toUpperCase();
}

/** Deterministic tone from the seed (typically the member's slug), so a
 *  member keeps the same colour across requests without storing one. */
export function toneFor(seed: string): BadgeTone {
  let hash = 0;
  for (
    let characterIndex = 0;
    characterIndex < seed.length;
    characterIndex += 1
  ) {
    hash = (hash * 31 + seed.charCodeAt(characterIndex)) >>> 0;
  }
  // invariant: `hash % BADGE_TONES.length` is always a valid index of the
  // non-empty BADGE_TONES constant.
  return BADGE_TONES[hash % BADGE_TONES.length]!;
}

/** A frozen (auto-frozen) account always reads as frozen, regardless of the
 *  suspended flag. Suspended-but-not-frozen reads as limited. Anything else
 *  with open reports is under review; the caller only invokes this when at
 *  least one of the three inputs is non-default. */
export function moderationStateFor(input: {
  suspended: boolean;
  frozen: boolean;
  openReportCount: number;
}): ModerationState {
  if (input.frozen) return 'frozen';
  if (input.suspended) return 'limited';
  return 'under_review';
}

export interface VouchAvatarDTO {
  initials: string;
  tone: BadgeTone;
  slug: string;
  avatarUrl: string | null;
}

/** Which way a vouch runs relative to the center (this member): `inbound` =
 *  they vouched FOR the member, `outbound` = the member vouched FOR them,
 *  `mutual` = both. */
export type VouchDirection = 'inbound' | 'outbound' | 'mutual';

/** A node in the detail-view trust graph, tagged with its direction so the
 *  drawer preview can show who trusts the member AND who the member vouches
 *  for, told apart visually. */
export interface VouchGraphNodeDTO extends VouchAvatarDTO {
  direction: VouchDirection;
}

export interface AdminMemberCardDTO {
  id: string;
  slug: string;
  name: string;
  initials: string;
  tone: BadgeTone;
  pronouns: string | null;
  verified: boolean;
  openReportCount: number;
  joinedAt: string;
  tagline: string | null;
  communities: string[];
  avatarUrl: string | null;
  vouchCount: number;
  vouchedBy: VouchAvatarDTO[];
}

export interface AdminMemberListDTO {
  items: AdminMemberCardDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FlaggedMemberDTO {
  id: string;
  slug: string;
  handle: string;
  initials: string;
  tone: BadgeTone;
  avatarUrl: string | null;
  openReportCount: number;
  topReasonCode: string | null;
  moderationState: ModerationState;
  joinedAt: string;
  latestReportDetail: string | null;
}

export interface AdminMemberModerationEntryDTO {
  tone: 'good' | 'neutral' | 'bad';
  action: string;
  reasonCode: string | null;
  actorName: string | null;
  note: string | null;
  at: string;
  reportId: string | null;
}

export interface AdminMemberDetailDTO {
  id: string;
  slug: string;
  name: string;
  initials: string;
  tone: BadgeTone;
  pronouns: string | null;
  verified: boolean;
  avatarUrl: string | null;
  vouchCount: number;
  /** How many members this member has vouched FOR (not withdrawn) — the
   *  outbound side of the trust graph, distinct from `vouchCount` (inbound). */
  outboundVouchCount: number;
  joinedAt: string;
  openReportCount: number;
  communities: { name: string; role: 'owner' | 'mod' | 'member' }[];
  contributions: { kind: string; detail: string | null; at: string }[];
  moderationTimeline: AdminMemberModerationEntryDTO[];
  graph: { center: VouchAvatarDTO; nodes: VouchGraphNodeDTO[] };
}

export function toAdminMemberCard(input: {
  profile: {
    userId: string;
    slug: string;
    firstName: string;
    lastName: string;
    pronouns: string | null;
    tagline: string | null;
    avatarUrl: string | null;
    verified: boolean;
    joinedAt: Date;
  };
  openReportCount: number;
  communities: string[];
  vouchCount: number;
  vouchedBy: VouchAvatarDTO[];
}): AdminMemberCardDTO {
  const { profile } = input;
  return {
    id: profile.userId,
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`.trim(),
    initials: initialsFor(profile.firstName, profile.lastName),
    tone: toneFor(profile.slug),
    pronouns: profile.pronouns,
    verified: profile.verified,
    openReportCount: input.openReportCount,
    joinedAt: profile.joinedAt.toISOString(),
    tagline: profile.tagline,
    communities: input.communities,
    avatarUrl: profile.avatarUrl,
    vouchCount: input.vouchCount,
    vouchedBy: input.vouchedBy,
  };
}

export function toFlaggedMember(input: {
  profile: {
    userId: string;
    slug: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    joinedAt: Date;
  };
  openReportCount: number;
  moderation: { suspended: boolean; frozen: boolean };
  topReasonCode: string | null;
  latestReportDetail: string | null;
}): FlaggedMemberDTO {
  const { profile } = input;
  return {
    id: profile.userId,
    slug: profile.slug,
    handle: `@${profile.slug}`,
    initials: initialsFor(profile.firstName, profile.lastName),
    tone: toneFor(profile.slug),
    avatarUrl: profile.avatarUrl,
    openReportCount: input.openReportCount,
    topReasonCode: input.topReasonCode,
    moderationState: moderationStateFor({
      suspended: input.moderation.suspended,
      frozen: input.moderation.frozen,
      openReportCount: input.openReportCount,
    }),
    joinedAt: profile.joinedAt.toISOString(),
    latestReportDetail: input.latestReportDetail,
  };
}

export function toAdminMemberDetail(input: {
  profile: {
    userId: string;
    slug: string;
    firstName: string;
    lastName: string;
    pronouns: string | null;
    avatarUrl: string | null;
    verified: boolean;
    joinedAt: Date;
  };
  openReportCount: number;
  vouchCount: number;
  outboundVouchCount: number;
  communities: { name: string; role: 'owner' | 'mod' | 'member' }[];
  contributions: { kind: string; detail: string | null; at: Date }[];
  moderationTimeline: {
    tone: 'good' | 'neutral' | 'bad';
    action: string;
    reasonCode: string | null;
    actorName: string | null;
    note: string | null;
    at: Date;
    reportId: string | null;
  }[];
  graph: { center: VouchAvatarDTO; nodes: VouchGraphNodeDTO[] };
}): AdminMemberDetailDTO {
  const { profile } = input;
  return {
    id: profile.userId,
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`.trim(),
    initials: initialsFor(profile.firstName, profile.lastName),
    tone: toneFor(profile.slug),
    pronouns: profile.pronouns,
    verified: profile.verified,
    avatarUrl: profile.avatarUrl,
    vouchCount: input.vouchCount,
    outboundVouchCount: input.outboundVouchCount,
    joinedAt: profile.joinedAt.toISOString(),
    openReportCount: input.openReportCount,
    communities: input.communities,
    contributions: input.contributions.map((contribution) => ({
      kind: contribution.kind,
      detail: contribution.detail,
      at: contribution.at.toISOString(),
    })),
    moderationTimeline: input.moderationTimeline.map((entry) => ({
      tone: entry.tone,
      action: entry.action,
      reasonCode: entry.reasonCode,
      actorName: entry.actorName,
      note: entry.note,
      at: entry.at.toISOString(),
      reportId: entry.reportId,
    })),
    graph: input.graph,
  };
}
