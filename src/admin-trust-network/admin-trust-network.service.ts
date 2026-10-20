import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import {
  foldedHaystack,
  foldedSearchTerm,
  PROFILE_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { toImageUrl } from '../common/image-url';
import { Community } from '../communities/entities/community.entity';
import { topLevelOnly } from '../communities/subcommunity-rules';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Invite } from '../membership/entities/invite.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  compareCodeUnits,
  type MemberAssessment,
  type RingAssessment,
  type TrustAssessment,
} from './admin-trust-network-assessment';
import { AdminTrustNetworkAssessmentService } from './admin-trust-network-assessment.service';
import { loadJoinPaths } from './admin-trust-network-join-paths';
import {
  buildScenes,
  CommunityMembershipInput,
  initialsFor,
  orderMembershipsPrimaryFirst,
  roleLabelFor,
  standingFor,
  toneFor,
  TrustCaseDTO,
  TrustEdgeDTO,
  TrustJoinPathDTO,
  TrustMemberRefDTO,
  TrustNetworkDTO,
  TrustNetworkMemberSearchResultDTO,
  TrustNetworkSummaryDTO,
  TrustNodeDTO,
  TrustRingDTO,
  TrustWeakVoucherDTO,
} from './admin-trust-network-response';
import { selectNodeUserIds } from './admin-trust-network-selection';
import { GetTrustNetworkQuery } from './dto/get-trust-network.query';

/** The graph DTO carries the top cases by score; `openCaseCount` keeps the
 *  platform-wide total. */
export const CASES_LIMIT = 50;

/** A member with no join record at all. */
const UNKNOWN_JOIN_PATH: TrustJoinPathDTO = {
  kind: 'unknown',
  bySlug: null,
  byName: null,
  at: null,
};

/** `searchMembers` typeahead: shortest term it fires on (a 1-char LIKE would
 *  match almost everyone) and the max rows returned. Mirrors
 *  AdminMediaService's uploader search. */
const MIN_SEARCH_LENGTH = 2;
const SEARCH_LIMIT = 20;

/** What `searchMembers` matches: names and handle, accent-folded (ENG-503) so
 *  "joao" finds "João". Database column names, qualified by the builder alias. */
const MEMBER_SEARCH_HAYSTACK = foldedHaystack(
  'profile',
  PROFILE_NAME_SEARCH_COLUMNS,
);

@Injectable()
export class AdminTrustNetworkService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(Invite) private readonly invites: Repository<Invite>,
    @InjectRepository(PlatformJoinRequest)
    private readonly joinRequests: Repository<PlatformJoinRequest>,
    private readonly assessmentService: AdminTrustNetworkAssessmentService,
  ) {}

  /**
   * The trust network around `focus` (or the newest members without one).
   * Nodes are picked by `selectNodeUserIds` (BFS from the focus, B10); every
   * per-member signal (standing, account kind, rings, isolation, track record,
   * counts) and the case list come from the cached platform-wide assessment,
   * so the graph, the triage list and the summary badge always agree.
   */
  async getGraph(query: GetTrustNetworkQuery = {}): Promise<TrustNetworkDTO> {
    const [assessment, totalMembers, focusUserId] = await Promise.all([
      this.assessmentService.getAssessment(),
      this.profiles.count(),
      this.resolveFocusUserId(query.focus),
    ]);

    const selectedUserIds = await selectNodeUserIds({
      focusUserId,
      loadNeighbourUserIds: (frontier) => this.loadNeighbourUserIds(frontier),
      loadJoinedAtByUserId: (userIds) => this.loadJoinedAtByUserId(userIds),
      loadNewestUserIds: (excludeUserIds, take) =>
        this.loadNewestUserIds(excludeUserIds, take),
    });
    const profiles = await this.loadProfilesInOrder(selectedUserIds);
    const truncated = totalMembers > profiles.length;

    const userIds = profiles.map((profile) => profile.userId);
    const slugByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile.slug]),
    );
    const assessmentByUserId = new Map(
      profiles.map((profile) => [
        profile.userId,
        assessment.byUserId.get(profile.userId) ??
          unassessedMember(profile.verified),
      ]),
    );

    const [membershipsByUserId, invitedByUserId] = await Promise.all([
      this.loadMemberships(userIds),
      this.loadInvitedByMap(userIds),
    ]);
    const joinPathByUserId = await loadJoinPaths(
      {
        invites: this.invites,
        joinRequests: this.joinRequests,
        profiles: this.profiles,
      },
      profiles.map((profile) => ({
        userId: profile.userId,
        invitedByUserId: invitedByUserId.get(profile.userId) ?? null,
        accountKind:
          assessmentByUserId.get(profile.userId)?.accountKind ?? 'member',
        joinedAt: profile.joinedAt,
      })),
    );

    // Nodes. Scene ids are community ids; every community any node belongs
    // to goes into the scenes list so each `sceneIds` entry resolves.
    const sceneLabelById = new Map<string, string>();
    const nodes: TrustNodeDTO[] = profiles.map((profile) => {
      const memberAssessment =
        assessmentByUserId.get(profile.userId) ??
        unassessedMember(profile.verified);
      const orderedMemberships = orderMembershipsPrimaryFirst(
        membershipsByUserId.get(profile.userId) ?? [],
      );
      for (const membership of orderedMemberships) {
        sceneLabelById.set(membership.communityId, membership.communityName);
      }
      const primaryMembership = orderedMemberships[0];
      return {
        id: profile.slug,
        userId: profile.userId,
        slug: profile.slug,
        name: `${profile.firstName} ${profile.lastName}`.trim(),
        pronouns: profile.pronouns,
        initials: initialsFor(profile.firstName, profile.lastName),
        tone: toneFor(profile.slug),
        avatarUrl: toImageUrl(profile.avatarUrl),
        joinedAt: profile.joinedAt.toISOString(),
        standing: memberAssessment.standing,
        inRing: memberAssessment.ringId !== null,
        sceneId: primaryMembership?.communityId ?? null,
        role: roleLabelFor(primaryMembership?.role ?? null),
        openReportCount:
          assessment.members.get(profile.userId)?.openReportCount ?? 0,
        verified: profile.verified,
        private: profile.privateNetwork,
        accountKind: memberAssessment.accountKind,
        ringId: memberAssessment.ringId,
        isolatedBy: weakVouchersFor(assessment, memberAssessment),
        joinPath: joinPathByUserId.get(profile.userId) ?? UNKNOWN_JOIN_PATH,
        trackRecord: {
          vouchesGiven: memberAssessment.trackRecord.vouchesGiven,
          laterFlaggedCount: memberAssessment.trackRecord.laterFlaggedCount,
        },
        activeInboundCount: memberAssessment.activeInboundCount,
        activeOutboundCount: memberAssessment.activeOutboundCount,
        sceneIds: orderedMemberships.map(
          (membership) => membership.communityId,
        ),
      };
    });

    // Edges: all vouches (incl. withdrawn) among the returned members.
    const includedUserIds = new Set(userIds);
    const vouchRows = userIds.length
      ? await this.vouches.find({
          where: { voucherId: In(userIds), voucheeId: In(userIds) },
          order: { createdAt: 'ASC' },
        })
      : [];
    // Active-pair set for mutual detection (withdrawn edges are never mutual).
    const activePairs = new Set(
      vouchRows
        .filter((vouchRow) => vouchRow.withdrawnAt === null)
        .map((vouchRow) => `${vouchRow.voucherId}>${vouchRow.voucheeId}`),
    );
    const edges: TrustEdgeDTO[] = [];
    for (const vouch of vouchRows) {
      const fromSlug = slugByUserId.get(vouch.voucherId);
      const toSlug = slugByUserId.get(vouch.voucheeId);
      // Drop any edge whose endpoint fell outside the node cap.
      if (
        !fromSlug ||
        !toSlug ||
        !includedUserIds.has(vouch.voucherId) ||
        !includedUserIds.has(vouch.voucheeId)
      ) {
        continue;
      }
      const mutual =
        vouch.withdrawnAt === null &&
        activePairs.has(`${vouch.voucheeId}>${vouch.voucherId}`);
      const kind: 'invite' | 'vouch' =
        invitedByUserId.get(vouch.voucheeId) === vouch.voucherId
          ? 'invite'
          : 'vouch';
      edges.push({
        id: `${fromSlug}>${toSlug}`,
        from: fromSlug,
        to: toSlug,
        mutual,
        withdrawn: vouch.withdrawnAt !== null,
        createdAt: vouch.createdAt.toISOString(),
        relationship: vouch.relationships?.[0] ?? null,
        note: vouch.note,
        anonymous: vouch.anonymous,
        kind,
      });
    }

    const rings: TrustRingDTO[] = assessment.rings
      .filter((ring) =>
        ring.memberUserIds.some((memberUserId) =>
          includedUserIds.has(memberUserId),
        ),
      )
      .map((ring) => ringDtoFor(assessment, ring));

    return {
      nodes,
      edges,
      scenes: buildScenes(sceneLabelById),
      truncated,
      rings,
      cases: caseDtosFor(assessment, CASES_LIMIT),
      openCaseCount: assessment.cases.length,
      platformStartedAt: assessment.platformStartedAt.toISOString(),
      newAccountWindowDays: assessment.newAccountWindowDays,
    };
  }

  /** The members page badge and entry point (`GET /admin/trust-network/summary`),
   *  read from the same cached assessment as `getGraph`. */
  async getSummary(): Promise<TrustNetworkSummaryDTO> {
    const assessment = await this.assessmentService.getAssessment();
    return {
      openCaseCount: assessment.cases.length,
      entrySlug: entrySlugFor(assessment),
    };
  }

  /** The focus profile's user id, or null when there is no focus or the slug
   *  matches nobody (the graph then opens on the newest members). */
  private async resolveFocusUserId(
    focus: string | undefined,
  ): Promise<string | null> {
    const focusSlug = focus?.trim();
    if (!focusSlug) return null;
    const focusProfile = await this.profiles.findOne({
      where: { slug: focusSlug },
      select: ['userId'],
    });
    return focusProfile?.userId ?? null;
  }

  /** One BFS level: every vouch row touching `frontier` (active and
   *  withdrawn, both directions), ids only. */
  private async loadNeighbourUserIds(frontier: string[]): Promise<string[]> {
    if (!frontier.length) return [];
    const rows = await this.vouches
      .createQueryBuilder('vouch')
      .select('vouch.voucher_id', 'voucherId')
      .addSelect('vouch.vouchee_id', 'voucheeId')
      .where(
        'vouch.voucher_id IN (:...frontier) OR vouch.vouchee_id IN (:...frontier)',
        { frontier },
      )
      .getRawMany<{ voucherId: string; voucheeId: string }>();
    return rows.flatMap((row) => [row.voucherId, row.voucheeId]);
  }

  private async loadJoinedAtByUserId(
    userIds: string[],
  ): Promise<Map<string, Date>> {
    if (!userIds.length) return new Map();
    const rows = await this.profiles.find({
      where: { userId: In(userIds) },
      select: ['userId', 'joinedAt'],
    });
    return new Map(rows.map((row) => [row.userId, row.joinedAt]));
  }

  /** Newest-joined user ids first, skipping `excludeUserIds`. */
  private async loadNewestUserIds(
    excludeUserIds: string[],
    take: number,
  ): Promise<string[]> {
    if (take <= 0) return [];
    const builder = this.profiles
      .createQueryBuilder('profile')
      .select('profile.user_id', 'userId');
    if (excludeUserIds.length) {
      builder.where('profile.user_id NOT IN (:...excludeUserIds)', {
        excludeUserIds,
      });
    }
    const rows = await builder
      .orderBy('profile.joinedAt', 'DESC')
      .addOrderBy('profile.userId', 'ASC')
      .limit(take)
      .getRawMany<{ userId: string }>();
    return rows.map((row) => row.userId);
  }

  /** Full profile rows for the selection, in selection order (focus first). */
  private async loadProfilesInOrder(userIds: string[]): Promise<Profile[]> {
    if (!userIds.length) return [];
    const rows = await this.profiles.find({ where: { userId: In(userIds) } });
    const orderByUserId = new Map(
      userIds.map((userId, index) => [userId, index]),
    );
    return rows.sort(
      (first, second) =>
        (orderByUserId.get(first.userId) ?? Number.MAX_SAFE_INTEGER) -
        (orderByUserId.get(second.userId) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  /** userId → the userId of whoever invited them (User.invited_by), or null. */
  private async loadInvitedByMap(
    userIds: string[],
  ): Promise<Map<string, string | null>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.users.find({
      where: { id: In(userIds) },
      loadRelationIds: { relations: ['invitedBy'] },
    });
    return new Map(
      rows.map((user) => [
        user.id,
        (user.invitedBy as unknown as string | null) ?? null,
      ]),
    );
  }

  /** Every top-level community each of `userIds` belongs to, for the trust
   *  network's scene labels. A space is excluded: those labels name
   *  top-level communities, and a space counts as part of its parent. */
  private async loadMemberships(
    userIds: string[],
  ): Promise<Map<string, CommunityMembershipInput[]>> {
    const byUserId = new Map<string, CommunityMembershipInput[]>();
    if (!userIds.length) return byUserId;
    const rows = await topLevelOnly(
      this.communityMembers
        .createQueryBuilder('member')
        .innerJoin(Community, 'community', 'community.id = member.community_id')
        .select('member.user_id', 'userId')
        .addSelect('member.role', 'role')
        .addSelect('community.id', 'communityId')
        .addSelect('community.name', 'communityName')
        .where('member.user_id IN (:...userIds)', { userIds }),
      'community',
    ).getRawMany<{
      userId: string;
      role: RosterRole;
      communityId: string;
      communityName: string;
    }>();
    // Community sizes for tie-breaking, one grouped query.
    const communityIds = [...new Set(rows.map((r) => r.communityId))];
    const sizeById = new Map<string, number>();
    if (communityIds.length) {
      const sizeRows = await this.communityMembers
        .createQueryBuilder('member')
        .select('member.community_id', 'communityId')
        .addSelect('COUNT(*)', 'count')
        .where('member.community_id IN (:...communityIds)', { communityIds })
        .groupBy('member.community_id')
        .getRawMany<{ communityId: string; count: string }>();
      for (const row of sizeRows)
        sizeById.set(row.communityId, Number(row.count));
    }
    for (const row of rows) {
      const list = byUserId.get(row.userId) ?? [];
      list.push({
        communityId: row.communityId,
        communityName: row.communityName,
        role: row.role,
        communitySize: sizeById.get(row.communityId) ?? 0,
      });
      byUserId.set(row.userId, list);
    }
    return byUserId;
  }

  /**
   * Typeahead behind the graph modal's "find a member" search box (ADM-10):
   * lets an admin locate any member, including one outside the MAX_NODES
   * selection around the current focus. Mirrors
   * `AdminMediaService.searchUploaders`: an accent-folded LIKE over first/last
   * name + slug, ordered by name, capped, and empty for a too-short term
   * (which would match almost everyone). Picking a result feeds its `slug`
   * back in as `getGraph`'s `focus`, which puts it first in the node set
   * regardless of join date.
   */
  async searchMembers(
    term: string | undefined,
  ): Promise<TrustNetworkMemberSearchResultDTO[]> {
    const trimmed = (term ?? '').trim();
    if (trimmed.length < MIN_SEARCH_LENGTH) return [];

    const pattern = `%${escapeLikeTerm(trimmed)}%`;
    const rows = await this.profiles
      .createQueryBuilder('profile')
      .where(
        `${MEMBER_SEARCH_HAYSTACK} LIKE ${foldedSearchTerm('pattern')} ESCAPE '\\'`,
        { pattern },
      )
      .orderBy('profile.firstName', 'ASC')
      .addOrderBy('profile.lastName', 'ASC')
      .take(SEARCH_LIMIT)
      .getMany();

    return rows.map((profile) => ({
      slug: profile.slug,
      name: `${profile.firstName} ${profile.lastName}`.trim(),
      initials: initialsFor(profile.firstName, profile.lastName),
      avatarUrl: toImageUrl(profile.avatarUrl),
    }));
  }
}

/** A node missing from the cached assessment (it joined inside the cache's
 *  60 s window) reads as an ordinary member with no signals until the next
 *  refresh. */
function unassessedMember(isVerified: boolean): MemberAssessment {
  return {
    accountKind: 'member',
    standing: standingFor({
      suspended: false,
      frozen: false,
      openReportCount: 0,
      verified: isVerified,
    }),
    ringId: null,
    isolatedBy: [],
    trackRecord: { vouchesGiven: 0, laterFlaggedCount: 0 },
    activeInboundCount: 0,
    activeOutboundCount: 0,
  };
}

/** userId to slug + display name, from the assessment's member roster. */
function memberRefFor(
  assessment: TrustAssessment,
  userId: string,
): TrustMemberRefDTO | null {
  const member = assessment.members.get(userId);
  return member ? { slug: member.slug, name: member.name } : null;
}

function weakVouchersFor(
  assessment: TrustAssessment,
  memberAssessment: MemberAssessment,
): TrustWeakVoucherDTO[] {
  return memberAssessment.isolatedBy.flatMap((weakVoucher) => {
    const voucherRef = memberRefFor(assessment, weakVoucher.userId);
    return voucherRef ? [{ ...voucherRef, reason: weakVoucher.reason }] : [];
  });
}

function ringDtoFor(
  assessment: TrustAssessment,
  ring: RingAssessment,
): TrustRingDTO {
  const memberSlugs = ring.memberUserIds
    .map((memberUserId) => memberRefFor(assessment, memberUserId)?.slug)
    .filter((slug): slug is string => slug !== undefined)
    .sort(compareCodeUnits);
  return {
    id: ring.id,
    memberSlugs,
    memberCount: ring.memberUserIds.length,
    firstJoinedAt: ring.firstJoinedAt.toISOString(),
    lastJoinedAt: ring.lastJoinedAt.toISOString(),
    sharedVouchers: ring.sharedVoucherUserIds
      .map((voucherUserId) => memberRefFor(assessment, voucherUserId))
      .filter(
        (voucherRef): voucherRef is TrustMemberRefDTO => voucherRef !== null,
      ),
  };
}

/** The top `limit` cases (the assessment keeps them ranked), with the
 *  subject resolved to slug + name. */
function caseDtosFor(
  assessment: TrustAssessment,
  limit: number,
): TrustCaseDTO[] {
  return assessment.cases.slice(0, limit).flatMap((trustCase) => {
    const subjectRef = memberRefFor(assessment, trustCase.subjectUserId);
    if (!subjectRef) return [];
    return [
      {
        id: trustCase.id,
        kind: trustCase.kind,
        subjectSlug: subjectRef.slug,
        subjectName: subjectRef.name,
        ringId: trustCase.ringId,
        memberCount: trustCase.memberCount,
        weakVoucherCount: trustCase.weakVoucherCount,
        openReportCount: trustCase.openReportCount,
        windowHours: trustCase.windowHours,
        score: trustCase.score,
      },
    ];
  });
}

/** Where the members page entry opens the graph: the top case's subject,
 *  else the earliest-joined staff or founder account, else null. */
function entrySlugFor(assessment: TrustAssessment): string | null {
  const topCase = assessment.cases[0];
  if (topCase) {
    const subjectRef = memberRefFor(assessment, topCase.subjectUserId);
    if (subjectRef) return subjectRef.slug;
  }

  let earliestMember: { slug: string; joinedAt: Date } | null = null;
  for (const [userId, memberAssessment] of assessment.byUserId) {
    if (
      memberAssessment.accountKind !== 'staff' &&
      memberAssessment.accountKind !== 'founder'
    ) {
      continue;
    }
    const member = assessment.members.get(userId);
    if (!member) continue;
    const isEarlier =
      earliestMember === null ||
      member.joinedAt.getTime() < earliestMember.joinedAt.getTime() ||
      (member.joinedAt.getTime() === earliestMember.joinedAt.getTime() &&
        member.slug.localeCompare(earliestMember.slug) < 0);
    if (isEarlier) earliestMember = member;
  }
  return earliestMember?.slug ?? null;
}
