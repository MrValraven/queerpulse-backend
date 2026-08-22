import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Invite, InviteStatus } from '../membership/entities/invite.entity';
import { resolveInviteStatus } from '../membership/invite-response';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminInviteDTO,
  AdminInviteInviterDTO,
  AdminInvitesPageDTO,
  toAdminInviteDTO,
} from './admin-invites-response';
import {
  AdminInviteStatusFilter,
  ListAdminInvitesQuery,
} from './dto/list-admin-invites.query';

/** One page of the admin invites list. */
export const ADMIN_INVITES_PAGE_SIZE = 20;

/**
 * Read model behind the admin dashboard's platform-wide invite oversight tab:
 * every invite ever minted (personal, approval-minted, or bootstrap), filterable
 * by resolved status / invitee email / a single inviter, newest-first, paginated.
 *
 * Every row is hand-mapped to `AdminInviteDTO` (never a raw entity), and the two
 * member refs per row (inviter + invitee) are resolved in TWO batched profile
 * lookups across the whole page — never one query per row — mirroring
 * `AdminMembersService`'s grouped-query pattern.
 */
@Injectable()
export class AdminInvitesService {
  constructor(
    @InjectRepository(Invite) private readonly invites: Repository<Invite>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async list(query: ListAdminInvitesQuery): Promise<AdminInvitesPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const now = new Date();

    const inviteQueryBuilder = this.invites.createQueryBuilder('invite');

    if (query.status) {
      this.applyStatusFilter(inviteQueryBuilder, query.status, now);
    }
    if (query.inviterId) {
      inviteQueryBuilder.andWhere('invite.inviterId = :inviterId', {
        inviterId: query.inviterId,
      });
    }
    const inviterSlug = query.inviterSlug?.trim();
    if (inviterSlug) {
      // Filter by the sender's slug the admin UI holds, resolved to their
      // userId inline. No status restriction on the join (unlike the active-only
      // `MemberLookup.userIdForSlug`), so filtering matches exactly the rows the
      // list shows — a suspended member's past invites still filter in.
      inviteQueryBuilder.andWhere(
        `invite.inviterId IN ${inviteQueryBuilder
          .subQuery()
          .select('profile.userId')
          .from(Profile, 'profile')
          .where('profile.slug = :inviterSlug')
          .getQuery()}`,
        { inviterSlug },
      );
    }
    const trimmedEmail = query.email?.trim();
    if (trimmedEmail) {
      inviteQueryBuilder.andWhere('invite.email ILIKE :email', {
        email: `%${this.escapeLike(trimmedEmail)}%`,
      });
    }

    inviteQueryBuilder
      .orderBy('invite.createdAt', 'DESC')
      .skip((page - 1) * ADMIN_INVITES_PAGE_SIZE)
      .take(ADMIN_INVITES_PAGE_SIZE);

    const [inviteRows, total] = await inviteQueryBuilder.getManyAndCount();
    if (!inviteRows.length) {
      return { items: [], total, page, pageSize: ADMIN_INVITES_PAGE_SIZE };
    }

    // Resolve inviter + invitee display refs for the whole page in one profile
    // lookup — both sides are userIds, so a single deduped `byUserIds` covers
    // them. `acceptedBy` is null while an invite is unredeemed.
    const memberLookup = new MemberLookup(this.profiles);
    const userIds = [
      ...new Set(
        inviteRows.flatMap((invite) =>
          invite.acceptedBy
            ? [invite.inviterId, invite.acceptedBy]
            : [invite.inviterId],
        ),
      ),
    ];
    const refsByUserId = await memberLookup.byUserIds(userIds);

    const items: AdminInviteDTO[] = inviteRows.map((invite) => {
      const inviter: MemberRef | null =
        refsByUserId.get(invite.inviterId) ?? null;
      const invitee: MemberRef | null = invite.acceptedBy
        ? (refsByUserId.get(invite.acceptedBy) ?? null)
        : null;
      return toAdminInviteDTO(invite, inviter, invitee, now);
    });

    return { items, total, page, pageSize: ADMIN_INVITES_PAGE_SIZE };
  }

  /**
   * Every member who has minted at least one invite, with their invite count,
   * newest lookups deduped to one row per sender and sorted by display name.
   * Powers the admin filter's sender dropdown so it can list every inviter
   * platform-wide (not only those on the pages already loaded). Resolved through
   * the same batched `MemberLookup.byUserIds` the list uses — no status filter,
   * so it matches exactly who can appear as an inviter in the rows.
   *
   * Also batch-fetches each inviter's `inviteMonthlyQuota` override in one
   * extra query (never one per row), so the admin invite-oversight page can
   * show and edit it inline without a second round trip per inviter.
   */
  async listInviters(): Promise<AdminInviteInviterDTO[]> {
    const grouped = await this.invites
      .createQueryBuilder('invite')
      .select('invite.inviterId', 'inviterId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('invite.inviterId')
      .getRawMany<{ inviterId: string; count: string }>();
    if (!grouped.length) return [];

    const inviterIds = grouped.map((row) => row.inviterId);
    const [refsByUserId, quotaRows] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(inviterIds),
      this.users.find({
        where: { id: In(inviterIds) },
        select: ['id', 'inviteMonthlyQuota'],
      }),
    ]);
    const quotaByUserId = new Map(
      quotaRows.map((userRow) => [userRow.id, userRow.inviteMonthlyQuota]),
    );

    return grouped
      .map((row): AdminInviteInviterDTO | null => {
        const ref = refsByUserId.get(row.inviterId);
        if (!ref) return null;
        return {
          slug: ref.slug,
          name: `${ref.firstName} ${ref.lastName}`.trim(),
          avatarUrl: ref.avatarUrl,
          count: Number(row.count),
          inviteMonthlyQuota: quotaByUserId.get(row.inviterId) ?? null,
        };
      })
      .filter((inviter): inviter is AdminInviteInviterDTO => inviter !== null)
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  /**
   * Revoke any still-valid invite platform-wide — `DELETE /admin/invites/:id`.
   *
   * The member-facing `DELETE /invites/:code` is scoped to `{ code, inviterId }`,
   * so an admin had no way at all to pull someone else's live invite link. This
   * is that missing lever: addressed by the internal `id` the admin list already
   * carries (never the shared `code`), and deliberately NOT scoped to an owner.
   *
   * Semantics, mirroring `InvitesService.revokeInvite`'s guards without its
   * ownership scoping:
   *  - 404 when no invite carries that id;
   *  - 409 when the invite is not revocable, keyed off the RESOLVED status the
   *    admin list shows (`resolveInviteStatus`) rather than the stored column —
   *    a `pending` row past its `expiresAt` reads as 'expired' in the UI and
   *    must answer the same way here, or the drawer would offer an action that
   *    reports a state nobody can see. Already-revoked is a conflict too, not a
   *    silent success: the admin surface only offers this on a valid invite, so
   *    a second call means the row moved underneath them and they should be
   *    told.
   *
   * The flip is a conditional `status = Pending` update (the same single-consume
   * guard `claimInvite` uses), so a redemption racing the revoke cannot both
   * win. The loser re-reads and reports the real terminal state.
   *
   * AUDITED, like every neighbouring admin action that changes another member's
   * standing (`AdminMembersService.updateRole` / `grantStaffRole` /
   * `updateInviteQuota`): a `mod_audit_logs` row with `action =
   * 'invite_revoked'`, the inviter as `targetUserId` + `targetName`, and the
   * invite code in `note`. Written in the SAME transaction as the status flip,
   * so the trail can never disagree with the column.
   */
  async revoke(inviteId: string, actorUserId: string): Promise<AdminInviteDTO> {
    const now = new Date();
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    this.assertRevocable(invite, now);

    const inviterRef =
      (await new MemberLookup(this.profiles).byUserIds([invite.inviterId])).get(
        invite.inviterId,
      ) ?? null;

    await this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        Invite,
        { id: invite.id, status: InviteStatus.Pending },
        { status: InviteStatus.Revoked },
      );
      if (result.affected !== 1) {
        // Lost a race with a redemption, the expiry sweeper, or a concurrent
        // revoke — re-read and report the state that actually won.
        const current = await manager.findOne(Invite, {
          where: { id: invite.id },
        });
        if (!current) {
          throw new NotFoundException('Invite not found');
        }
        this.assertRevocable(current, new Date());
        throw new ConflictException('Only a valid invite can be revoked.');
      }

      const auditLogs = manager.getRepository(ModAuditLog);
      await auditLogs.save(
        auditLogs.create({
          reportId: null,
          actorId: actorUserId,
          targetUserId: invite.inviterId,
          targetName: inviterRef
            ? `${inviterRef.firstName} ${inviterRef.lastName}`.trim()
            : null,
          action: 'invite_revoked',
          reasonCode: null,
          note: invite.code,
          duration: null,
        }),
      );
    });

    const revoked = await this.invites.findOne({ where: { id: invite.id } });
    if (!revoked) {
      throw new NotFoundException('Invite not found');
    }
    // A revoked invite was never redeemed, so there is no invitee to resolve —
    // `acceptedBy` is null by construction on this path.
    return toAdminInviteDTO(revoked, inviterRef, null, now);
  }

  /** 409 with the reason an invite cannot be revoked, or return quietly when it
   *  can. Reads the RESOLVED status so a lapsed-but-unswept `pending` row is
   *  reported as expired, exactly as the admin list renders it. */
  private assertRevocable(invite: Invite, now: Date): void {
    const status = resolveInviteStatus(invite, now);
    if (status === 'valid') return;
    if (status === 'used') {
      throw new ConflictException(
        'This invite has already been accepted, so there is nothing to revoke.',
      );
    }
    if (status === 'revoked') {
      throw new ConflictException('This invite was already revoked.');
    }
    throw new ConflictException(
      'This invite has already expired, so there is nothing to revoke.',
    );
  }

  /**
   * Translate the resolved-status filter the admin picked into SQL, so the
   * paginated `total` matches exactly the rows shown. 'expired' and 'valid' both
   * have to reach into `expires_at` because a still-`pending` row past its
   * expiry resolves as 'expired' but is only stored 'expired' once swept.
   */
  private applyStatusFilter(
    inviteQueryBuilder: SelectQueryBuilder<Invite>,
    status: AdminInviteStatusFilter,
    now: Date,
  ): void {
    switch (status) {
      case 'used':
        inviteQueryBuilder.andWhere('invite.status = :accepted', {
          accepted: InviteStatus.Accepted,
        });
        break;
      case 'revoked':
        inviteQueryBuilder.andWhere('invite.status = :revoked', {
          revoked: InviteStatus.Revoked,
        });
        break;
      case 'expired':
        inviteQueryBuilder.andWhere(
          '(invite.status = :expired OR (invite.status = :pending AND invite.expiresAt IS NOT NULL AND invite.expiresAt <= :now))',
          { expired: InviteStatus.Expired, pending: InviteStatus.Pending, now },
        );
        break;
      case 'valid':
        inviteQueryBuilder.andWhere(
          '(invite.status = :pending AND (invite.expiresAt IS NULL OR invite.expiresAt > :now))',
          { pending: InviteStatus.Pending, now },
        );
        break;
    }
  }

  /** Escape LIKE/ILIKE wildcards so an admin's literal search text can't be
   *  read as a pattern (a `%` in the box means the character, not "any run"). */
  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`);
  }
}
