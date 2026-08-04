import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Invite, InviteStatus } from '../membership/entities/invite.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminInviteDTO,
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
