import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { MemberLookup, MemberRef } from '../common/member-ref';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  initialsFor,
  toneFor,
  toAdminMemberCard,
  toAdminMemberDetail,
  toFlaggedMember,
  AdminMemberDetailDTO,
  AdminMemberListDTO,
  FlaggedMemberDTO,
  VouchAvatarDTO,
} from './admin-members-response';
import { ListAdminMembersQuery } from './dto/list-admin-members.query';

/** One page of the admin members list, everywhere this feature paginates. */
export const ADMIN_MEMBERS_PAGE_SIZE = 20;

/** The `filter: 'new'` window on `list()` — "joined in the last week". */
const NEW_MEMBER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How many of a member's most recent vouchers are shown as avatars on the
 *  list card. */
const TOP_VOUCHERS_LIMIT = 4;

/** How many vouch-graph nodes (people who vouched for this member) are
 *  fetched for the detail view's trust graph. */
const GRAPH_NODE_LIMIT = 12;

/** How many recent given-vouch contributions are shown on the detail view. */
const CONTRIBUTION_LIMIT = 6;

// `Report.subjectId` for a `Member` subject is stored as either the member's
// slug or their raw userId (see the entity doc) — mirrors `UUID_RE` in both
// `AdminCommunitiesService` and `ModerationService.resolveReportedProfile`.
// A non-UUID string can never match a `uuid` column, so it is only ever tried
// against `slug`; a UUID-shaped one is tried against both, same as
// `resolveReportedProfile`.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors the (small, closed) set of `ModAuditLog.action` codes written by
// `ModerationService` — `MOD_ACTION_CODES` in `dto/mod-action.dto.ts`
// (`dismiss`, `warn`, `hide_content`, `remove_content`, `restrict`,
// `suspend`, `ban`, `shield`, `escalate`) plus the two appeal/lift-only codes
// seen in `moderation.service.ts` (`appeal_upheld`, `suspension_lifted`).
// Not imported from there: like `AdminCommunitiesService`'s duplicated
// `UUID_RE`, this is a private vocabulary detail of a different module, not a
// shared export — `warn`/`escalate`/any future/unknown code fall through to
// 'neutral' rather than erroring.
const GOOD_MODERATION_ACTIONS = new Set([
  'dismiss',
  'appeal_upheld',
  'suspension_lifted',
]);
const BAD_MODERATION_ACTIONS = new Set([
  'hide_content',
  'remove_content',
  'restrict',
  'suspend',
  'ban',
  'shield',
]);

type ModerationTimelineEntryInput = Parameters<
  typeof toAdminMemberDetail
>[0]['moderationTimeline'][number];
type ContributionInput = Parameters<
  typeof toAdminMemberDetail
>[0]['contributions'][number];

/**
 * Read model behind the admin dashboard's members tab: the paginated roster,
 * the flagged-members queue, and one member's full detail view.
 *
 * Every aggregate (vouch counts, top vouchers, open-report counts, community
 * names) is computed with one batched query per metric across the whole page
 * of members — never one query per member — mirroring
 * `AdminCommunitiesService`'s grouped-query pattern.
 */
@Injectable()
export class AdminMembersService {
  private readonly logger = new Logger(AdminMembersService.name);

  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(ModAuditLog)
    private readonly modAuditLogs: Repository<ModAuditLog>,
    private readonly vouchService: VouchService,
  ) {}

  async list(query: ListAdminMembersQuery): Promise<AdminMemberListDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;

    const profileQueryBuilder = this.profiles
      .createQueryBuilder('profile')
      .innerJoin('profile.user', 'user', 'user.status = :active', {
        active: UserStatus.Active,
      });

    if (query.filter === 'verified') {
      profileQueryBuilder.andWhere('profile.verified = true');
    } else if (query.filter === 'new') {
      profileQueryBuilder.andWhere('profile.joinedAt >= :since', {
        since: new Date(Date.now() - NEW_MEMBER_WINDOW_MS),
      });
    }

    profileQueryBuilder
      .orderBy('profile.firstName', 'ASC')
      .skip((page - 1) * ADMIN_MEMBERS_PAGE_SIZE)
      .take(ADMIN_MEMBERS_PAGE_SIZE);

    const [profileRows, total] = await profileQueryBuilder.getManyAndCount();
    if (!profileRows.length) {
      return { items: [], total, page, pageSize: ADMIN_MEMBERS_PAGE_SIZE };
    }

    const userIds = profileRows.map((profileRow) => profileRow.userId);
    const slugs = profileRows.map((profileRow) => profileRow.slug);

    const [
      vouchCountsByUserId,
      topVouchersByVouchee,
      openReportCountByUserId,
      communityNamesByUserId,
    ] = await Promise.all([
      this.vouchService.getVouchCounts(userIds),
      this.loadTopVouchers(userIds),
      this.loadOpenReportCounts(userIds, slugs),
      this.loadCommunityNames(userIds),
    ]);

    const items = profileRows.map((profileRow) =>
      toAdminMemberCard({
        profile: {
          userId: profileRow.userId,
          slug: profileRow.slug,
          firstName: profileRow.firstName,
          lastName: profileRow.lastName,
          pronouns: profileRow.pronouns,
          tagline: profileRow.tagline,
          avatarUrl: toImageUrl(profileRow.avatarUrl),
          verified: profileRow.verified,
          joinedAt: profileRow.joinedAt,
        },
        openReportCount: openReportCountByUserId.get(profileRow.userId) ?? 0,
        communities: communityNamesByUserId.get(profileRow.userId) ?? [],
        vouchCount: vouchCountsByUserId.get(profileRow.userId) ?? 0,
        vouchedBy: topVouchersByVouchee.get(profileRow.userId) ?? [],
      }),
    );

    return { items, total, page, pageSize: ADMIN_MEMBERS_PAGE_SIZE };
  }

  async listFlagged(): Promise<FlaggedMemberDTO[]> {
    const [openMemberReports, suspendedUsers] = await Promise.all([
      this.reports.find({
        where: {
          subjectType: ReportSubjectType.Member,
          status: In([ReportStatus.Open, ReportStatus.Escalated]),
        },
        order: { createdAt: 'DESC' },
      }),
      this.users.find({
        where: { status: UserStatus.Suspended },
        select: ['id'],
      }),
    ]);

    const suspendedUserIds = new Set(
      suspendedUsers.map((suspendedUser) => suspendedUser.id),
    );

    const reportsByOwnerUserId =
      await this.groupReportsByDiscoveredOwner(openMemberReports);

    const flaggedUserIds = [
      ...new Set([...reportsByOwnerUserId.keys(), ...suspendedUserIds]),
    ];
    if (!flaggedUserIds.length) return [];

    const profilesForFlaggedMembers = await this.profiles.find({
      where: { userId: In(flaggedUserIds) },
    });
    const resolvedUserIds = new Set(
      profilesForFlaggedMembers.map((profile) => profile.userId),
    );
    for (const flaggedUserId of flaggedUserIds) {
      if (!resolvedUserIds.has(flaggedUserId)) {
        this.logger.warn(
          `Member ${flaggedUserId} is flagged (open report or suspension) but has no profile row; omitting from the flagged list.`,
        );
      }
    }

    return profilesForFlaggedMembers.map((profile) => {
      const reportsForMember = reportsByOwnerUserId.get(profile.userId) ?? [];
      const openReportCount = reportsForMember.length;
      const suspended = suspendedUserIds.has(profile.userId);
      // Simple, documented heuristic — there is no dedicated "auto-frozen"
      // column anywhere in the schema. `moderationStateFor` only ever
      // distinguishes "frozen" from "limited" among suspended accounts, so
      // the split has to come from something else already on hand: whether
      // the suspension still has open reports driving it. Suspended with
      // open reports still outstanding reads as "limited" (an active,
      // in-progress case); suspended with none left open reads as "frozen"
      // (enforcement has run its course, nothing left under active review).
      const frozen = suspended && openReportCount === 0;
      return toFlaggedMember({
        profile: {
          userId: profile.userId,
          slug: profile.slug,
          firstName: profile.firstName,
          lastName: profile.lastName,
          joinedAt: profile.joinedAt,
        },
        openReportCount,
        moderation: { suspended, frozen },
        topReasonCode: this.topReasonCodeFor(reportsForMember),
        latestReportDetail: reportsForMember[0]?.detail ?? null,
      });
    });
  }

  async getMember(idOrSlug: string): Promise<AdminMemberDetailDTO> {
    const where = UUID_RE.test(idOrSlug)
      ? [{ slug: idOrSlug }, { userId: idOrSlug }]
      : [{ slug: idOrSlug }];
    const profile = await this.profiles.findOne({ where });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }

    const memberLookup = new MemberLookup(this.profiles);

    const [
      vouchCount,
      vouchersReceived,
      memberReports,
      communityRows,
      vouchesGiven,
    ] = await Promise.all([
      this.vouchService.getVouchCount(profile.userId),
      this.vouches.find({
        where: { voucheeId: profile.userId },
        order: { createdAt: 'DESC' },
        take: GRAPH_NODE_LIMIT,
      }),
      this.reports.find({
        where: {
          subjectType: ReportSubjectType.Member,
          subjectId: In([profile.slug, profile.userId]),
        },
        order: { createdAt: 'DESC' },
      }),
      this.communityMembers
        .createQueryBuilder('member')
        .innerJoin(Community, 'community', 'community.id = member.community_id')
        .select('member.role', 'role')
        .addSelect('community.name', 'name')
        .where('member.user_id = :userId', { userId: profile.userId })
        .getRawMany<{ role: RosterRole; name: string }>(),
      this.vouches.find({
        where: { voucherId: profile.userId },
        order: { createdAt: 'DESC' },
        take: CONTRIBUTION_LIMIT,
      }),
    ]);

    const openReportCount = memberReports.filter(
      (report) =>
        report.status === ReportStatus.Open ||
        report.status === ReportStatus.Escalated,
    ).length;
    const reportIds = memberReports.map((report) => report.id);

    const [auditLogEntries, voucherRefsByUserId, voucheeRefsByUserId] =
      await Promise.all([
        reportIds.length
          ? this.modAuditLogs.find({
              where: { reportId: In(reportIds) },
              order: { createdAt: 'ASC' },
            })
          : Promise.resolve([] as ModAuditLog[]),
        memberLookup.byUserIds(
          vouchersReceived.map((vouch) => vouch.voucherId),
        ),
        memberLookup.byUserIds(vouchesGiven.map((vouch) => vouch.voucheeId)),
      ]);

    const actorUserIds = [
      ...new Set(
        auditLogEntries
          .map((auditLogEntry) => auditLogEntry.actorId)
          .filter((actorId): actorId is string => actorId !== null),
      ),
    ];
    const actorRefsByUserId = await memberLookup.byUserIds(actorUserIds);

    const communities = communityRows.map((communityRow) => ({
      name: communityRow.name,
      role: this.toRosterRoleLabel(communityRow.role),
    }));

    const contributions: ContributionInput[] = vouchesGiven.map((vouch) => {
      const voucheeRef = voucheeRefsByUserId.get(vouch.voucheeId);
      return {
        kind: 'vouch',
        detail: voucheeRef
          ? `Vouched for ${voucheeRef.firstName} ${voucheeRef.lastName}`.trim()
          : 'Vouched for a member',
        at: vouch.createdAt,
      };
    });

    const moderationTimeline: ModerationTimelineEntryInput[] =
      auditLogEntries.map((auditLogEntry) => ({
        tone: this.toneForModAction(auditLogEntry.action),
        action: auditLogEntry.action,
        reasonCode: auditLogEntry.reasonCode,
        actorName: this.actorNameFor(auditLogEntry.actorId, actorRefsByUserId),
        note: auditLogEntry.note,
        at: auditLogEntry.createdAt,
        reportId: auditLogEntry.reportId,
      }));
    if (profile.verified) {
      moderationTimeline.push({
        tone: 'good',
        action: 'verified',
        reasonCode: null,
        actorName: null,
        note: null,
        at: profile.joinedAt,
        reportId: null,
      });
    }
    if (openReportCount === 0) {
      // Not a historical event (there is no "at" the platform recorded) —
      // stamped with the moment this detail view was built, purely so it can
      // slot into the same chronological timeline as everything else.
      moderationTimeline.push({
        tone: 'good',
        action: 'no_reports',
        reasonCode: null,
        actorName: null,
        note: null,
        at: new Date(),
        reportId: null,
      });
    }
    moderationTimeline.sort(
      (firstEntry, secondEntry) =>
        firstEntry.at.getTime() - secondEntry.at.getTime(),
    );

    const graphNodes = vouchersReceived
      .map((vouch) => voucherRefsByUserId.get(vouch.voucherId))
      .filter((memberRef): memberRef is MemberRef => memberRef !== undefined)
      .map((memberRef) =>
        this.toVouchAvatar(
          memberRef.firstName,
          memberRef.lastName,
          memberRef.slug,
          memberRef.avatarUrl,
        ),
      );

    return toAdminMemberDetail({
      profile: {
        userId: profile.userId,
        slug: profile.slug,
        firstName: profile.firstName,
        lastName: profile.lastName,
        pronouns: profile.pronouns,
        avatarUrl: toImageUrl(profile.avatarUrl),
        verified: profile.verified,
        joinedAt: profile.joinedAt,
      },
      openReportCount,
      vouchCount,
      communities,
      contributions,
      moderationTimeline,
      graph: {
        center: this.toVouchAvatar(
          profile.firstName,
          profile.lastName,
          profile.slug,
          toImageUrl(profile.avatarUrl),
        ),
        nodes: graphNodes,
      },
    });
  }

  /**
   * `listFlagged` doesn't know its member set up front — it has to discover
   * it from the reports themselves. Every `Report.subjectId` for a `Member`
   * subject is always tried as a slug; a UUID-shaped one is also tried as a
   * raw userId (mirrors `ModerationService.resolveReportedProfile`, batched
   * across every report in ONE profile lookup instead of one per report).
   */
  private async groupReportsByDiscoveredOwner(
    memberSubjectReports: Report[],
  ): Promise<Map<string, Report[]>> {
    const reportsByOwnerUserId = new Map<string, Report[]>();
    if (!memberSubjectReports.length) return reportsByOwnerUserId;

    const distinctSubjectIds = [
      ...new Set(memberSubjectReports.map((report) => report.subjectId)),
    ];
    const uuidShapedSubjectIds = distinctSubjectIds.filter((subjectId) =>
      UUID_RE.test(subjectId),
    );

    const profileWhereConditions = uuidShapedSubjectIds.length
      ? [{ slug: In(distinctSubjectIds) }, { userId: In(uuidShapedSubjectIds) }]
      : [{ slug: In(distinctSubjectIds) }];
    const matchingProfiles = await this.profiles.find({
      where: profileWhereConditions,
    });

    const ownerUserIdBySubjectId = new Map<string, string>();
    for (const matchingProfile of matchingProfiles) {
      if (distinctSubjectIds.includes(matchingProfile.slug)) {
        ownerUserIdBySubjectId.set(
          matchingProfile.slug,
          matchingProfile.userId,
        );
      }
      if (uuidShapedSubjectIds.includes(matchingProfile.userId)) {
        ownerUserIdBySubjectId.set(
          matchingProfile.userId,
          matchingProfile.userId,
        );
      }
    }

    for (const report of memberSubjectReports) {
      const ownerUserId = ownerUserIdBySubjectId.get(report.subjectId);
      if (!ownerUserId) continue; // subjectId resolves to no live profile
      const existingReports = reportsByOwnerUserId.get(ownerUserId);
      if (existingReports) {
        existingReports.push(report);
      } else {
        reportsByOwnerUserId.set(ownerUserId, [report]);
      }
    }
    return reportsByOwnerUserId;
  }

  /** The most frequent `reasonCode` among a member's open reports; ties break
   *  toward the most recent occurrence, since `reportsForMember` is already
   *  newest-first. */
  private topReasonCodeFor(reportsForMember: Report[]): string | null {
    if (!reportsForMember.length) return null;
    const countByReasonCode = new Map<string, number>();
    for (const report of reportsForMember) {
      countByReasonCode.set(
        report.reasonCode,
        (countByReasonCode.get(report.reasonCode) ?? 0) + 1,
      );
    }
    let topReasonCode: string | null = null;
    let topCount = 0;
    for (const report of reportsForMember) {
      const count = countByReasonCode.get(report.reasonCode) ?? 0;
      if (count > topCount) {
        topCount = count;
        topReasonCode = report.reasonCode;
      }
    }
    return topReasonCode;
  }

  /** Top `TOP_VOUCHERS_LIMIT` most recent vouchers per vouchee, across every
   *  given `voucheeIds`, in one query. */
  private async loadTopVouchers(
    voucheeIds: string[],
  ): Promise<Map<string, VouchAvatarDTO[]>> {
    const topVouchersByVouchee = new Map<string, VouchAvatarDTO[]>();
    if (!voucheeIds.length) return topVouchersByVouchee;

    const vouchRows = await this.vouches
      .createQueryBuilder('vouch')
      .select(['vouch.voucherId', 'vouch.voucheeId', 'vouch.createdAt'])
      .where('vouch.voucheeId IN (:...voucheeIds)', { voucheeIds })
      .orderBy('vouch.createdAt', 'DESC')
      .getMany();

    // Rows arrive newest-first across the WHOLE set, so capping each group at
    // TOP_VOUCHERS_LIMIT while iterating in that order keeps only each
    // vouchee's most recent vouchers, with no per-vouchee re-sort needed.
    const vouchRowsByVouchee = new Map<string, Vouch[]>();
    for (const vouchRow of vouchRows) {
      const existingRows = vouchRowsByVouchee.get(vouchRow.voucheeId);
      if (existingRows) {
        if (existingRows.length < TOP_VOUCHERS_LIMIT) {
          existingRows.push(vouchRow);
        }
      } else {
        vouchRowsByVouchee.set(vouchRow.voucheeId, [vouchRow]);
      }
    }

    const voucherIds = [
      ...new Set(
        [...vouchRowsByVouchee.values()]
          .flat()
          .map((vouchRow) => vouchRow.voucherId),
      ),
    ];
    const memberLookup = new MemberLookup(this.profiles);
    const voucherRefsByUserId = await memberLookup.byUserIds(voucherIds);

    for (const [voucheeId, vouchRowsForVouchee] of vouchRowsByVouchee) {
      const vouchAvatars: VouchAvatarDTO[] = [];
      for (const vouchRow of vouchRowsForVouchee) {
        const voucherRef = voucherRefsByUserId.get(vouchRow.voucherId);
        if (voucherRef) {
          vouchAvatars.push(
            this.toVouchAvatar(
              voucherRef.firstName,
              voucherRef.lastName,
              voucherRef.slug,
              voucherRef.avatarUrl,
            ),
          );
        }
      }
      topVouchersByVouchee.set(voucheeId, vouchAvatars);
    }
    return topVouchersByVouchee;
  }

  /** Open/escalated report counts for a page of members in one grouped
   *  query. `userIds` and `slugs` are parallel arrays (same member, same
   *  index) since a report's `subjectId` may use either form. */
  private async loadOpenReportCounts(
    userIds: string[],
    slugs: string[],
  ): Promise<Map<string, number>> {
    const openReportCountByUserId = new Map<string, number>();
    const subjectIds = [...userIds, ...slugs];
    if (!subjectIds.length) return openReportCountByUserId;

    const countRows = await this.reports
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

    const countBySubjectId = new Map(
      countRows.map((countRow) => [countRow.subjectId, Number(countRow.count)]),
    );
    for (let rowIndex = 0; rowIndex < userIds.length; rowIndex += 1) {
      const userId = userIds[rowIndex];
      const slug = slugs[rowIndex];
      openReportCountByUserId.set(
        userId,
        (countBySubjectId.get(userId) ?? 0) + (countBySubjectId.get(slug) ?? 0),
      );
    }
    return openReportCountByUserId;
  }

  /** Every community name each of `userIds` belongs to, in one query. */
  private async loadCommunityNames(
    userIds: string[],
  ): Promise<Map<string, string[]>> {
    const communityNamesByUserId = new Map<string, string[]>();
    if (!userIds.length) return communityNamesByUserId;

    const rows = await this.communityMembers
      .createQueryBuilder('member')
      .innerJoin(Community, 'community', 'community.id = member.community_id')
      .select('member.user_id', 'userId')
      .addSelect('community.name', 'name')
      .where('member.user_id IN (:...userIds)', { userIds })
      .getRawMany<{ userId: string; name: string }>();

    for (const row of rows) {
      const existingNames = communityNamesByUserId.get(row.userId);
      if (existingNames) {
        existingNames.push(row.name);
      } else {
        communityNamesByUserId.set(row.userId, [row.name]);
      }
    }
    return communityNamesByUserId;
  }

  private toRosterRoleLabel(role: RosterRole): 'owner' | 'mod' | 'member' {
    if (role === RosterRole.Owner) return 'owner';
    if (role === RosterRole.Mod) return 'mod';
    return 'member';
  }

  /** `null` actorId means the acting moderator erased their account (see
   *  `ModAuditLog.actorId`'s doc) — mirrors `AuditEntryDTO`'s 'Deleted
   *  member' fallback in `moderation-response.ts`. A non-null actorId with no
   *  resolvable profile is a defensive fallback that should not occur. */
  private actorNameFor(
    actorId: string | null,
    actorRefsByUserId: Map<string, MemberRef>,
  ): string | null {
    if (!actorId) return 'Deleted member';
    const actorRef = actorRefsByUserId.get(actorId);
    if (!actorRef) return 'Unknown moderator';
    return `${actorRef.firstName} ${actorRef.lastName}`.trim();
  }

  private toneForModAction(action: string): 'good' | 'neutral' | 'bad' {
    if (GOOD_MODERATION_ACTIONS.has(action)) return 'good';
    if (BAD_MODERATION_ACTIONS.has(action)) return 'bad';
    return 'neutral';
  }

  private toVouchAvatar(
    firstName: string,
    lastName: string,
    slug: string,
    avatarUrl: string | null,
  ): VouchAvatarDTO {
    return {
      initials: initialsFor(firstName, lastName),
      tone: toneFor(slug),
      slug,
      avatarUrl,
    };
  }
}
