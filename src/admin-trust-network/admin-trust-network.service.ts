import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
  TrustNodeDTO,
} from './admin-trust-network-response';

/** Payload cap: the most-recently-joined members and all edges among them.
 *  Well above current scale; `truncated` signals when it bites. */
const MAX_NODES = 500;

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

  async getGraph(): Promise<TrustNetworkDTO> {
    const totalMembers = await this.profiles.count();
    const profiles = await this.profiles.find({
      order: { joinedAt: 'DESC' },
      take: MAX_NODES,
    });
    const truncated = totalMembers > profiles.length;

    const userIds = profiles.map((profile) => profile.userId);
    const slugs = profiles.map((profile) => profile.slug);
    const slugByUserId = new Map(profiles.map((p) => [p.userId, p.slug]));

    const [openReportCountByUserId, suspendedUserIds, membershipsByUserId] =
      await Promise.all([
        this.loadOpenReportCounts(userIds, slugs),
        this.loadSuspendedUserIds(userIds),
        this.loadMemberships(userIds),
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
      edges.push({
        id: `${fromSlug}>${toSlug}`,
        from: fromSlug,
        to: toSlug,
        mutual,
        withdrawn: vouch.withdrawnAt !== null,
        createdAt: vouch.createdAt.toISOString(),
        relationship: vouch.relationship,
        note: vouch.note,
        anonymous: vouch.anonymous,
      });
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
      byUserId.set(
        userIds[index],
        (bySubject.get(userIds[index]) ?? 0) +
          (bySubject.get(slugs[index]) ?? 0),
      );
    }
    return byUserId;
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
}
