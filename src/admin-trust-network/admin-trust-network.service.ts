import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { toImageUrl } from '../common/image-url';
import { Community } from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  buildScenes,
  CommunityMembershipInput,
  initialsFor,
  roleLabelFor,
  sceneFor,
  standingFor,
  toneFor,
  TrustEdgeDTO,
  TrustNetworkDTO,
  TrustNetworkMemberSearchResultDTO,
  TrustNodeDTO,
} from './admin-trust-network-response';
import { detectRingSlugs } from './admin-trust-network-ring';
import { GetTrustNetworkQuery } from './dto/get-trust-network.query';

/** Payload cap: the most-recently-joined members and all edges among them.
 *  Well above current scale; `truncated` signals when it bites. */
const MAX_NODES = 500;

/** `searchMembers` typeahead: shortest term it fires on (a 1-char ILIKE would
 *  match almost everyone) and the max rows returned. Mirrors
 *  AdminMediaService's uploader search. */
const MIN_SEARCH_LENGTH = 2;
const SEARCH_LIMIT = 20;

@Injectable()
export class AdminTrustNetworkService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
  ) {}

  async getGraph(query: GetTrustNetworkQuery = {}): Promise<TrustNetworkDTO> {
    const totalMembers = await this.profiles.count();
    const newest = await this.profiles.find({
      order: { joinedAt: 'DESC' },
      take: MAX_NODES,
    });

    // `focus` pins the member the graph modal is centered on into the node
    // set even when their join date falls outside the newest-first cutoff —
    // otherwise opening an older member's network renders as "not found"
    // just because they joined a while ago (ADM-10).
    const focusSlug = query.focus?.trim();
    const focusProfile =
      focusSlug && !newest.some((profile) => profile.slug === focusSlug)
        ? await this.profiles.findOne({ where: { slug: focusSlug } })
        : null;
    const profiles = focusProfile ? [focusProfile, ...newest] : newest;
    const truncated = totalMembers > profiles.length;

    const userIds = profiles.map((profile) => profile.userId);
    const slugs = profiles.map((profile) => profile.slug);
    const slugByUserId = new Map(profiles.map((p) => [p.userId, p.slug]));

    const [
      openReportCountByUserId,
      suspendedUserIds,
      membershipsByUserId,
      invitedByUserId,
    ] = await Promise.all([
      this.loadOpenReportCounts(userIds, slugs),
      this.loadSuspendedUserIds(userIds),
      this.loadMemberships(userIds),
      this.loadInvitedByMap(userIds),
    ]);

    // Nodes. sceneId is a community id; collect labels for the scenes list.
    const sceneLabelById = new Map<string, string>();
    const nodes: TrustNodeDTO[] = profiles.map((profile) => {
      const openReportCount = openReportCountByUserId.get(profile.userId) ?? 0;
      const suspended = suspendedUserIds.has(profile.userId);
      const frozen = suspended && openReportCount === 0;
      const scene = sceneFor(membershipsByUserId.get(profile.userId) ?? []);
      if (scene) sceneLabelById.set(scene.id, scene.label);
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
        standing: standingFor({
          suspended,
          frozen,
          openReportCount,
          verified: profile.verified,
        }),
        // Real value computed below, once the edges (which `detectRingSlugs`
        // needs) exist — this placeholder just satisfies the DTO shape.
        inRing: false,
        sceneId: scene?.id ?? null,
        role: roleLabelFor(scene?.role ?? null),
        openReportCount,
        verified: profile.verified,
        private: profile.privateNetwork,
      };
    });

    // Edges: all vouches (incl. withdrawn) among the returned members.
    const includedUserIds = new Set(userIds);
    const vouchRows = await this.vouches.find({
      where: [{ voucherId: In(userIds) }, { voucheeId: In(userIds) }],
      order: { createdAt: 'ASC' },
    });
    // Active-pair set for mutual detection (withdrawn edges are not "mutual").
    const activePairs = new Set(
      vouchRows
        .filter((v) => v.withdrawnAt === null)
        .map((v) => `${v.voucherId}>${v.voucheeId}`),
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

    // ADM-23: real ring detection now that both nodes (standing/verified) and
    // edges (active vouches) exist — mutates each node's placeholder `inRing`
    // in place rather than rebuilding the array.
    const ringSlugs = detectRingSlugs(
      nodes.map((node) => ({
        id: node.slug,
        verified: node.verified,
        standing: node.standing,
      })),
      edges,
    );
    for (const node of nodes) {
      node.inRing = ringSlugs.has(node.slug);
    }

    return { nodes, edges, scenes: buildScenes(sceneLabelById), truncated };
  }

  private async loadOpenReportCounts(
    userIds: string[],
    slugs: string[],
  ): Promise<Map<string, number>> {
    const byUserId = new Map<string, number>();
    const subjectIds = [...userIds, ...slugs];
    if (!subjectIds.length) return byUserId;
    const rows = await this.reports
      .createQueryBuilder('report')
      .select('report.subject_id', 'subjectId')
      .addSelect('COUNT(*)', 'count')
      .where('report.subject_type = :subjectType', {
        subjectType: ReportSubjectType.Member,
      })
      .andWhere('report.status IN (:...statuses)', {
        statuses: [ReportStatus.Open, ReportStatus.Escalated],
      })
      .andWhere('report.subject_id IN (:...subjectIds)', { subjectIds })
      .groupBy('report.subject_id')
      .getRawMany<{ subjectId: string; count: string }>();
    const bySubject = new Map(rows.map((r) => [r.subjectId, Number(r.count)]));
    for (let index = 0; index < userIds.length; index += 1) {
      const userId = userIds[index];
      const slug = slugs[index];
      if (userId === undefined || slug === undefined) continue;
      byUserId.set(
        userId,
        (bySubject.get(userId) ?? 0) + (bySubject.get(slug) ?? 0),
      );
    }
    return byUserId;
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

  private async loadSuspendedUserIds(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows = await this.users.find({
      where: { id: In(userIds), status: UserStatus.Suspended },
      select: ['id'],
    });
    return new Set(rows.map((row) => row.id));
  }

  private async loadMemberships(
    userIds: string[],
  ): Promise<Map<string, CommunityMembershipInput[]>> {
    const byUserId = new Map<string, CommunityMembershipInput[]>();
    if (!userIds.length) return byUserId;
    const rows = await this.communityMembers
      .createQueryBuilder('member')
      .innerJoin(Community, 'community', 'community.id = member.community_id')
      .select('member.user_id', 'userId')
      .addSelect('member.role', 'role')
      .addSelect('community.id', 'communityId')
      .addSelect('community.name', 'communityName')
      .where('member.user_id IN (:...userIds)', { userIds })
      .getRawMany<{
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
   * Typeahead behind the graph modal's "find a member" search box (ADM-10) —
   * lets an admin locate a member outside the MAX_NODES join-date window
   * instead of only ever seeing the newest MAX_NODES. Mirrors
   * `AdminMediaService.searchUploaders`: ILIKE over first/last name + slug,
   * ordered by name, capped, empty for a too-short term rather than matching
   * almost everyone. Picking a result feeds its `slug` back in as `getGraph`'s
   * `focus`, which pins it into the node set regardless of join date.
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
        '(profile.firstName ILIKE :pattern OR profile.lastName ILIKE :pattern OR profile.slug ILIKE :pattern)',
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
