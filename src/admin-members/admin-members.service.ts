import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
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
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { StaffRoleId } from '../users/staff-roles.registry';
import { VouchService } from '../vouch/vouch.service';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  initialsFor,
  toneFor,
  toAdminMemberCard,
  toAdminMemberDetail,
  toAdminMemberRole,
  toFlaggedMember,
  AdminMemberDetailDTO,
  AdminMemberListDTO,
  AdminMemberRoleDTO,
  FlaggedMemberDTO,
  VouchAvatarDTO,
  VouchGraphNodeDTO,
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
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    private readonly vouchService: VouchService,
    private readonly dataSource: DataSource,
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
      roleByUserId,
      staffRolesByUserId,
    ] = await Promise.all([
      this.vouchService.getVouchCounts(userIds),
      this.loadTopVouchers(userIds),
      this.loadOpenReportCounts(userIds, slugs),
      this.loadCommunityNames(userIds),
      this.loadRolesByUserId(userIds),
      this.loadStaffRolesByUserId(userIds),
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
        role: roleByUserId.get(profileRow.userId) ?? UserRole.Member,
        openReportCount: openReportCountByUserId.get(profileRow.userId) ?? 0,
        communities: communityNamesByUserId.get(profileRow.userId) ?? [],
        vouchCount: vouchCountsByUserId.get(profileRow.userId) ?? 0,
        vouchedBy: topVouchersByVouchee.get(profileRow.userId) ?? [],
        staffRoles: staffRolesByUserId.get(profileRow.userId) ?? [],
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
          avatarUrl: toImageUrl(profile.avatarUrl),
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
      userRow,
      vouchCount,
      outboundVouchCount,
      vouchersReceived,
      memberReports,
      communityRows,
      vouchesGiven,
      staffRoleRows,
    ] = await Promise.all([
      this.users.findOne({
        where: { id: profile.userId },
        select: ['id', 'role', 'isSystem'],
      }),
      this.vouchService.getVouchCount(profile.userId),
      this.vouches.count({
        where: { voucherId: profile.userId, withdrawnAt: IsNull() },
      }),
      this.vouches.find({
        where: { voucheeId: profile.userId, withdrawnAt: IsNull() },
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
        where: { voucherId: profile.userId, withdrawnAt: IsNull() },
        order: { createdAt: 'DESC' },
        take: CONTRIBUTION_LIMIT,
      }),
      this.staffRoles.find({
        where: { userId: profile.userId },
        select: ['role'],
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

    // The trust graph carries BOTH directions: people who vouched for this
    // member (inbound) and people this member vouched for (outbound). Someone
    // on both sides collapses to a single `mutual` node. Deduped by slug.
    const graphNodeBySlug = new Map<string, VouchGraphNodeDTO>();
    const inboundOnlySlugs: string[] = [];
    const outboundOnlySlugs: string[] = [];

    for (const vouch of vouchersReceived) {
      const memberRef = voucherRefsByUserId.get(vouch.voucherId);
      if (!memberRef || graphNodeBySlug.has(memberRef.slug)) continue;
      graphNodeBySlug.set(memberRef.slug, {
        ...this.toVouchAvatar(
          memberRef.firstName,
          memberRef.lastName,
          memberRef.slug,
          memberRef.avatarUrl,
        ),
        direction: 'inbound',
      });
      inboundOnlySlugs.push(memberRef.slug);
    }

    for (const vouch of vouchesGiven) {
      const memberRef = voucheeRefsByUserId.get(vouch.voucheeId);
      if (!memberRef) continue;
      const existing = graphNodeBySlug.get(memberRef.slug);
      if (existing) {
        // Already inbound → they vouch for each other.
        existing.direction = 'mutual';
        continue;
      }
      graphNodeBySlug.set(memberRef.slug, {
        ...this.toVouchAvatar(
          memberRef.firstName,
          memberRef.lastName,
          memberRef.slug,
          memberRef.avatarUrl,
        ),
        direction: 'outbound',
      });
      outboundOnlySlugs.push(memberRef.slug);
    }

    // Order: mutual first (the strongest signal), then round-robin the two
    // one-way sets so a downstream node cap can never drop a whole direction.
    const nodeFor = (slug: string) => graphNodeBySlug.get(slug)!;
    const inboundOnly = inboundOnlySlugs
      .map(nodeFor)
      .filter((node) => node.direction === 'inbound');
    const outboundOnly = outboundOnlySlugs.map(nodeFor);
    const graphNodes: VouchGraphNodeDTO[] = [
      ...graphNodeBySlug.values(),
    ].filter((node) => node.direction === 'mutual');
    const maxOneWayLength = Math.max(inboundOnly.length, outboundOnly.length);
    for (let nodeIndex = 0; nodeIndex < maxOneWayLength; nodeIndex += 1) {
      const inboundNode = inboundOnly[nodeIndex];
      if (inboundNode) graphNodes.push(inboundNode);
      const outboundNode = outboundOnly[nodeIndex];
      if (outboundNode) graphNodes.push(outboundNode);
    }

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
      role: userRow?.role ?? UserRole.Member,
      isSystem: userRow?.isSystem ?? false,
      openReportCount,
      vouchCount,
      outboundVouchCount,
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
      staffRoles: staffRoleRows.map((staffRoleRow) => staffRoleRow.role),
    });
  }

  /**
   * Grant or revoke `moderator` / `admin` on one member — the platform's only
   * way to make (or unmake) staff without editing the database by hand. The
   * body carries the target role in full, so this one method covers every
   * transition.
   *
   * Guardrails, all enforced here in the service (not the controller), and the
   * last-admin check + write done in one transaction so two admins demoting the
   * last two admins concurrently can't both pass their count read:
   *  - an admin can never change their OWN role (no accidental self-lockout,
   *    and no self-promotion games) — `actorUserId` vs. the target;
   *  - a `isSystem` house account's role is immutable (it is deliberately a
   *    plain `member` that never rides `RolesGuard`);
   *  - the LAST admin can never be demoted, or the platform loses every admin
   *    surface with no way back in.
   *
   * The change is recorded in the shared `mod_audit_logs` trail with a NULL
   * `reportId` (it is not report-driven), mirroring how a lifted suspension is
   * logged. Such rows intentionally don't surface in the report-filtered audit
   * feed or a member's report timeline.
   */
  async updateRole(
    actorUserId: string,
    idOrSlug: string,
    targetRole: UserRole,
  ): Promise<AdminMemberRoleDTO> {
    const profile = await this.resolveMemberProfile(idOrSlug);
    const targetUserId = profile.userId;

    if (targetUserId === actorUserId) {
      throw new ForbiddenException(
        'You can’t change your own role — ask another admin to do it.',
      );
    }

    const appliedRole = await this.dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const targetUser = await users.findOne({
        where: { id: targetUserId },
        select: ['id', 'role', 'isSystem'],
      });
      if (!targetUser) {
        throw new NotFoundException('Member not found');
      }

      if (targetUser.isSystem) {
        throw new ForbiddenException(
          'The house account’s role can’t be changed.',
        );
      }

      const previousRole = targetUser.role;
      if (previousRole === targetRole) {
        // Nothing changed — return without writing an audit row for a no-op.
        return previousRole;
      }

      // Demoting an admin: never let the final admin lose the role, or the
      // platform is locked out of every admin surface. Counted inside the
      // transaction so a concurrent demotion can't slip past a stale count.
      if (previousRole === UserRole.Admin && targetRole !== UserRole.Admin) {
        const adminCount = await users.count({
          where: { role: UserRole.Admin },
        });
        if (adminCount <= 1) {
          throw new ConflictException(
            'This is the last admin — promote another member to admin before removing this one.',
          );
        }
      }

      await users.update({ id: targetUserId }, { role: targetRole });

      const auditLogs = manager.getRepository(ModAuditLog);
      await auditLogs.save(
        auditLogs.create({
          reportId: null,
          actorId: actorUserId,
          action: 'role_changed',
          reasonCode: null,
          note: `${previousRole} → ${targetRole}`,
          duration: null,
        }),
      );

      return targetRole;
    });

    return toAdminMemberRole({
      userId: targetUserId,
      slug: profile.slug,
      role: appliedRole,
      isSystem: false,
    });
  }

  /**
   * Resolves the member behind an admin-facing `:id` route param, which may
   * be either the profile slug or the raw userId — the lookup `updateRole`
   * has always done, now shared with `grantStaffRole`/`revokeStaffRole` too.
   */
  private async resolveMemberProfile(idOrSlug: string): Promise<Profile> {
    const where = UUID_RE.test(idOrSlug)
      ? [{ slug: idOrSlug }, { userId: idOrSlug }]
      : [{ slug: idOrSlug }];
    const profile = await this.profiles.findOne({ where });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    return profile;
  }

  /**
   * Grant one additive "staff role" (`STAFF_ROLES`) to a member — orthogonal
   * to `updateRole`'s account tier, so unlike it there is deliberately NEITHER
   * a self-grant block (an admin already holds every capability, so granting
   * themselves a staff role is harmless) NOR a last-holder guardrail (zero
   * holders of a given staff role is a valid state).
   *
   * Idempotent: granting a role the member already holds writes no duplicate
   * `user_staff_roles` row and no second audit entry. Mirrors `updateRole`'s
   * house-account guardrail — the `isSystem` account can't hold staff roles
   * either. The change is recorded in `mod_audit_logs` with a NULL `reportId`
   * and the role id as the `note`, the same shape `updateRole` uses for
   * `role_changed`.
   *
   * Also idempotent under a race: two concurrent grants of the same
   * `(userId, role)` can both pass the `alreadyHeld` check and race on the
   * INSERT, and the loser hits the `@Unique(['userId', 'role'])` constraint on
   * `user_staff_roles`. Postgres poisons the whole transaction on that
   * failure (no further statements can run on it without a ROLLBACK), so the
   * loser's in-transaction recompute never happens — but the winner already
   * committed the row (and the one audit entry), so the desired end state is
   * already true. The `catch` below detects exactly that unique-violation
   * (mirrors `VouchService.vouch` / `JoinRequestsService`'s use of
   * `isUniqueViolation`) and recomputes `staffRoles` on a fresh query
   * instead of surfacing a 500.
   */
  async grantStaffRole(
    actorUserId: string,
    idOrSlug: string,
    role: StaffRoleId,
  ): Promise<{ userId: string; slug: string; staffRoles: string[] }> {
    const profile = await this.resolveMemberProfile(idOrSlug);
    const targetUserId = profile.userId;

    let staffRoleList: string[];
    try {
      staffRoleList = await this.dataSource.transaction(async (manager) => {
        const users = manager.getRepository(User);
        const targetUser = await users.findOne({
          where: { id: targetUserId },
          select: ['id', 'isSystem'],
        });
        if (!targetUser) {
          throw new NotFoundException('Member not found');
        }
        if (targetUser.isSystem) {
          throw new ForbiddenException(
            'The house account can’t hold staff roles.',
          );
        }

        const grants = manager.getRepository(UserStaffRole);
        const alreadyHeld = await grants.findOne({
          where: { userId: targetUserId, role },
        });
        if (!alreadyHeld) {
          await grants.save(
            grants.create({
              userId: targetUserId,
              role,
              grantedById: actorUserId,
            }),
          );

          const auditLogs = manager.getRepository(ModAuditLog);
          await auditLogs.save(
            auditLogs.create({
              reportId: null,
              actorId: actorUserId,
              action: 'staff_role_granted',
              reasonCode: null,
              note: role,
              duration: null,
            }),
          );
        }

        const holdings = await grants.find({
          where: { userId: targetUserId },
          select: ['role'],
        });
        return holdings.map((holding) => holding.role);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Race loser: the winner's grant (and audit row) already committed, so
      // this is not a real conflict — don't write a second audit row, just
      // report the now-current holdings from a fresh query (the aborted
      // transaction above can't run any more statements).
      const holdings = await this.staffRoles.find({
        where: { userId: targetUserId },
        select: ['role'],
      });
      staffRoleList = holdings.map((holding) => holding.role);
    }

    return {
      userId: targetUserId,
      slug: profile.slug,
      staffRoles: staffRoleList,
    };
  }

  /**
   * Revoke one additive staff role. A no-op — no delete, no audit row — when
   * the member doesn't hold it, mirroring `updateRole`'s no-op-on-same-role
   * path. Same house-account guardrail as `grantStaffRole`.
   */
  async revokeStaffRole(
    actorUserId: string,
    idOrSlug: string,
    role: StaffRoleId,
  ): Promise<{ userId: string; slug: string; staffRoles: string[] }> {
    const profile = await this.resolveMemberProfile(idOrSlug);
    const targetUserId = profile.userId;

    const staffRoleList = await this.dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const targetUser = await users.findOne({
        where: { id: targetUserId },
        select: ['id', 'isSystem'],
      });
      if (!targetUser) {
        throw new NotFoundException('Member not found');
      }
      if (targetUser.isSystem) {
        throw new ForbiddenException(
          'The house account can’t hold staff roles.',
        );
      }

      const grants = manager.getRepository(UserStaffRole);
      const deleteResult = await grants.delete({
        userId: targetUserId,
        role,
      });
      if (deleteResult.affected) {
        const auditLogs = manager.getRepository(ModAuditLog);
        await auditLogs.save(
          auditLogs.create({
            reportId: null,
            actorId: actorUserId,
            action: 'staff_role_revoked',
            reasonCode: null,
            note: role,
            duration: null,
          }),
        );
      }

      const holdings = await grants.find({
        where: { userId: targetUserId },
        select: ['role'],
      });
      return holdings.map((holding) => holding.role);
    });

    return {
      userId: targetUserId,
      slug: profile.slug,
      staffRoles: staffRoleList,
    };
  }

  /**
   * Set or clear one member's monthly invite quota override
   * (`User.inviteMonthlyQuota`). `quota === null` clears it, falling back to
   * the platform-wide `INVITE_MONTHLY_QUOTA` default the next time
   * `InvitesService.resolveMonthlyLimit` reads it. Unlike `updateRole` /
   * `grantStaffRole`, this is a resource-limits lever rather than a
   * moderation action, so there is deliberately no self-change or
   * house-account guardrail — the class-level Admin-only guard is the only
   * gate. No audit-log entry either, mirroring how the column itself has
   * always been a silent, direct-DB-edit affordance up to now — this
   * endpoint just gives that same lever a UI.
   */
  async updateInviteQuota(
    idOrSlug: string,
    quota: number | null,
  ): Promise<{
    userId: string;
    slug: string;
    inviteMonthlyQuota: number | null;
  }> {
    const profile = await this.resolveMemberProfile(idOrSlug);
    const targetUserId = profile.userId;

    await this.users.update(
      { id: targetUserId },
      { inviteMonthlyQuota: quota },
    );

    return {
      userId: targetUserId,
      slug: profile.slug,
      inviteMonthlyQuota: quota,
    };
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

    // Bounded fetch. The naive "load ALL vouch rows for these voucheeIds, then
    // cap per-group in JS" pulls thousands of rows for a heavily-vouched member
    // only to discard all but TOP_VOUCHERS_LIMIT of them. A ROW_NUMBER() window
    // ranks each vouchee's vouchers newest-first IN SQL and the outer WHERE
    // keeps only the top N per group, so the DB returns at most
    // voucheeIds.length * TOP_VOUCHERS_LIMIT rows regardless of vouch volume —
    // same per-group "most recent N" semantics as the previous JS cap.
    // (`this.vouches.manager.createQueryBuilder()` — a builder with NO initial
    // FROM — so the subquery is the sole FROM, not a comma-join against
    // `vouches`.)
    const rankedRows = await this.vouches.manager
      .createQueryBuilder()
      .select('ranked.voucher_id', 'voucherId')
      .addSelect('ranked.vouchee_id', 'voucheeId')
      .from(
        (subQuery) =>
          subQuery
            .select('inner_vouch.voucher_id', 'voucher_id')
            .addSelect('inner_vouch.vouchee_id', 'vouchee_id')
            .addSelect(
              'ROW_NUMBER() OVER (PARTITION BY inner_vouch.vouchee_id ORDER BY inner_vouch.created_at DESC, inner_vouch.id DESC)',
              'rn',
            )
            .from(Vouch, 'inner_vouch')
            .where('inner_vouch.vouchee_id IN (:...voucheeIds)', { voucheeIds })
            .andWhere('inner_vouch.withdrawn_at IS NULL'),
        'ranked',
      )
      .where('ranked.rn <= :topVouchersLimit', {
        topVouchersLimit: TOP_VOUCHERS_LIMIT,
      })
      .orderBy('ranked.vouchee_id')
      .addOrderBy('ranked.rn')
      .getRawMany<{ voucherId: string; voucheeId: string }>();

    // Rows arrive already capped at TOP_VOUCHERS_LIMIT per vouchee and ordered
    // newest-first within each group (rn ascending), so grouping is a plain
    // append with no re-sort or re-cap needed.
    const vouchRowsByVouchee = new Map<
      string,
      { voucherId: string; voucheeId: string }[]
    >();
    for (const rankedRow of rankedRows) {
      const existingRows = vouchRowsByVouchee.get(rankedRow.voucheeId);
      if (existingRows) {
        existingRows.push(rankedRow);
      } else {
        vouchRowsByVouchee.set(rankedRow.voucheeId, [rankedRow]);
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
      if (userId === undefined || slug === undefined) continue;
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

  /** Platform role for a page of members, in one query, so the roster can show
   *  each member's role without an N+1 or joining `user` onto every card. */
  private async loadRolesByUserId(
    userIds: string[],
  ): Promise<Map<string, UserRole>> {
    const roleByUserId = new Map<string, UserRole>();
    if (!userIds.length) return roleByUserId;
    const userRows = await this.users.find({
      where: { id: In(userIds) },
      select: ['id', 'role'],
    });
    for (const userRow of userRows) {
      roleByUserId.set(userRow.id, userRow.role);
    }
    return roleByUserId;
  }

  /** Staff-role grants for a page of members, in one batched query (never one
   *  per member) — mirrors `loadRolesByUserId`. */
  private async loadStaffRolesByUserId(
    userIds: string[],
  ): Promise<Map<string, string[]>> {
    const staffRolesByUserId = new Map<string, string[]>();
    if (!userIds.length) return staffRolesByUserId;
    const grantRows = await this.staffRoles.find({
      where: { userId: In(userIds) },
      select: ['userId', 'role'],
    });
    for (const grantRow of grantRows) {
      const existing = staffRolesByUserId.get(grantRow.userId);
      if (existing) {
        existing.push(grantRow.role);
      } else {
        staffRolesByUserId.set(grantRow.userId, [grantRow.role]);
      }
    }
    return staffRolesByUserId;
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
