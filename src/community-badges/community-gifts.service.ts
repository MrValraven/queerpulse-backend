// Staff gifts: the sender's weekly allowance, sending, the recipient's shelf,
// hiding, removing and the visible gift marks of one member (routes 7 to 12).
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import {
  MAX_PAGE,
  Paginated,
  normalizePage,
  paginate,
} from '../common/pagination';
import { membersOnlyException } from '../communities/community-gate';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  isCommunityOwnerLevelRole,
  isCommunityStaffRole,
} from '../communities/community-staff-access';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import { Community } from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import {
  CommunityBadgeAccessDeps,
  resolveForAnyCaller,
  resolveForBoardRead,
  resolveForRole,
} from './community-badge-access';
import {
  isCommunityBadgeUuid,
  normalizeGiftHidden,
  normalizeGiftSend,
} from './community-badge-input';
import {
  CommunityGiftAllowanceDTO,
  CommunityMemberGiftDTO,
  CommunitySentGiftDTO,
  CommunityShelfGiftDTO,
  toCommunityGiftAllowanceDTO,
  toCommunityMemberGiftDTO,
  toCommunityShelfGiftDTO,
  toCommunitySentGiftDTO,
} from './community-badge-response';
import { COMMUNITY_GIFT_WEEKLY_LIMIT } from './community-badges.catalog';
import { communityBadgeError } from './community-badges.constants';
import { scrubGiftNoteFromRecipientNotification } from './community-gift-takedown';
import {
  SendCommunityGiftDto,
  UpdateCommunityGiftDto,
} from './dto/community-badges.dto';
import { CommunityGift } from './entities/community-gift.entity';

/** The sender's gifts in one community over the last 7 days and the sentAt of
 * the oldest one counted. `$1` is the community id, `$2` the sender id.
 * Removed gifts count toward the cap. */
export const ALLOWANCE_SQL = `SELECT count(*)::int AS "used", min("sent_at") AS "oldest_sent_at" FROM "community_gifts" WHERE "community_id" = $1 AND "sender_id" = $2 AND "sent_at" > now() - interval '7 days'`;

/** The per-sender, per-community transaction lock taken before the allowance
 * count, so two sends at once cannot both pass the cap. `$1` is the key from
 * `giftSenderLockKey`. */
export const GIFT_SENDER_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))`;

/** Most visible gift marks one member read returns. */
export const COMMUNITY_MEMBER_GIFT_MARKS_LIMIT = 50;

/** Keeps the marks of a recipient the roster hides: an account that is not
 * active (paused, suspended, inside the deletion grace) or a member who chose
 * "Hide me for 24h" (`hidden_until` still in the future). The same rule as
 * `CommunitiesService.roster`; the member themself skips it. */
export const MEMBER_MARKS_RECIPIENT_LISTED_SQL = `EXISTS (
  SELECT 1 FROM "users" "mark_member"
  INNER JOIN "profiles" "mark_profile"
    ON "mark_profile"."user_id" = "mark_member"."id"
  WHERE "mark_member"."id" = "gift"."recipient_id"
    AND "mark_member"."status" = :markMemberActiveStatus
    AND (
      "mark_profile"."hidden_until" IS NULL
      OR "mark_profile"."hidden_until" <= now()
    )
)`;

/** The advisory lock key of one sender in one community. */
export function giftSenderLockKey(
  communityId: string,
  senderId: string,
): string {
  return `community-gift:${communityId}:${senderId}`;
}

/** One row of `ALLOWANCE_SQL`. */
interface AllowanceRow {
  used: number;
  oldest_sent_at: Date | string | null;
}

/** The count and the oldest counted sentAt of one row of `ALLOWANCE_SQL`,
 * or of no row at all. */
function allowanceCountFromRows(rows: AllowanceRow[] | undefined): {
  used: number;
  oldestSentAt: Date | null;
} {
  const row = rows?.[0];
  return {
    used: Number(row?.used ?? 0),
    oldestSentAt:
      row?.oldest_sent_at != null ? new Date(row.oldest_sent_at) : null,
  };
}

/** The allowance of one row of `ALLOWANCE_SQL`, or of no row at all. */
function allowanceFromRows(
  rows: AllowanceRow[] | undefined,
): CommunityGiftAllowanceDTO {
  const { used, oldestSentAt } = allowanceCountFromRows(rows);
  return toCommunityGiftAllowanceDTO(used, oldestSentAt);
}

/** A page number from a raw query value: a whole number from 1 to `MAX_PAGE`,
 * and the first page for anything else. */
function pageFromQuery(page: unknown): number {
  return Math.min(normalizePage(Math.floor(Number(page))), MAX_PAGE);
}

/**
 * Routes 7 to 12 of the community badges contract: staff gifts. The weekly cap
 * is counted under a per-sender advisory lock inside the send transaction;
 * governance rows for gifts carry the gift id and key and never the note.
 */
@Injectable()
export class CommunityGiftsService {
  private readonly logger = new Logger(CommunityGiftsService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityGift)
    private readonly gifts: Repository<CommunityGift>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly membership: CommunityMembershipService,
    private readonly contentModeration: ContentModerationService,
    private readonly governanceLog: CommunityGovernanceLogService,
    private readonly blockFilter: BlockFilterService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The collaborators the access functions read. */
  private get accessDeps(): CommunityBadgeAccessDeps {
    return {
      communities: this.communities,
      membership: this.membership,
      contentModeration: this.contentModeration,
    };
  }

  /** Route 7: the caller's weekly gift allowance in this community. Staff
   * only; reads carry no archive filter. */
  async allowance(
    slug: string,
    userId: string,
  ): Promise<CommunityGiftAllowanceDTO> {
    const { community } = await resolveForRole(this.accessDeps, {
      slug,
      userId,
      isWrite: false,
      tier: 'staff',
      refusalCode: 'gift_sender_not_staff',
    });
    return this.readAllowance(community.id, userId);
  }

  /** Route 8: send one gift to a current member of this community. The cap is
   * checked and the gift written under the sender lock; the recipient is
   * notified after commit with the sender as actor, so their blocks and mutes
   * apply. A notification failure is logged and the gift stands. */
  async send(
    slug: string,
    senderId: string,
    body: SendCommunityGiftDto,
  ): Promise<CommunitySentGiftDTO> {
    const { community } = await resolveForRole(this.accessDeps, {
      slug,
      userId: senderId,
      isWrite: true,
      tier: 'staff',
      refusalCode: 'gift_sender_not_staff',
    });
    const input = normalizeGiftSend(body);
    const memberLookup = new MemberLookup(this.profiles);
    const recipientId = await memberLookup.userIdForSlug(input.recipientSlug);
    if (recipientId === null) {
      throw communityBadgeError('gift_recipient_not_member');
    }
    const isRecipientOnRoster = await this.members.exists({
      where: { communityId: community.id, userId: recipientId },
    });
    if (!isRecipientOnRoster) {
      throw communityBadgeError('gift_recipient_not_member');
    }
    if (recipientId === senderId) {
      throw communityBadgeError('gift_to_self');
    }
    if (await this.blockFilter.isBlockedEitherWay(senderId, recipientId)) {
      throw communityBadgeError('gift_recipient_unavailable');
    }
    const recipientRef = (await memberLookup.byUserIds([recipientId])).get(
      recipientId,
    );
    if (!recipientRef) {
      throw communityBadgeError('gift_recipient_not_member');
    }

    const { gift, allowanceAfter } = await this.dataSource.transaction(
      async (manager) => {
        await manager.query(GIFT_SENDER_LOCK_SQL, [
          giftSenderLockKey(community.id, senderId),
        ]);
        const countBefore = allowanceCountFromRows(
          await manager.query<AllowanceRow[]>(ALLOWANCE_SQL, [
            community.id,
            senderId,
          ]),
        );
        if (countBefore.used >= COMMUNITY_GIFT_WEEKLY_LIMIT) {
          throw communityBadgeError('gift_weekly_limit_reached', {
            limit: COMMUNITY_GIFT_WEEKLY_LIMIT,
            resetsAt:
              toCommunityGiftAllowanceDTO(
                countBefore.used,
                countBefore.oldestSentAt,
              ).resetsAt ?? undefined,
          });
        }
        const giftRepository = manager.getRepository(CommunityGift);
        const saved = await giftRepository.save(
          giftRepository.create({
            communityId: community.id,
            senderId,
            recipientId,
            giftKey: input.giftKey,
            note: input.note,
            hiddenByRecipientAt: null,
            removedAt: null,
            removedById: null,
          }),
        );
        await this.governanceLog.log(
          {
            communityId: community.id,
            actorUserId: senderId,
            action: GovernanceLogAction.GiftSent,
            targetUserId: recipientId,
            metadata: { giftId: saved.id, giftKey: saved.giftKey },
          },
          manager,
        );
        // The allowance after this gift follows from the count taken under the
        // lock: one more gift, and the window opens at the oldest counted gift,
        // or at this one when it is the first in the window.
        return {
          gift: saved,
          allowanceAfter: toCommunityGiftAllowanceDTO(
            countBefore.used + 1,
            countBefore.oldestSentAt ?? saved.sentAt,
          ),
        };
      },
    );

    await this.notifyRecipient(community, gift, senderId);
    return toCommunitySentGiftDTO(gift, recipientRef, allowanceAfter);
  }

  /** Route 9: the caller's own gift shelf, newest first, hidden gifts
   * included and removed ones left out. Members only. */
  async listMine(
    slug: string,
    userId: string,
    page?: unknown,
  ): Promise<Paginated<CommunityShelfGiftDTO>> {
    const { community } = await resolveForBoardRead(this.accessDeps, {
      slug,
      userId,
    });
    const isOnRoster = await this.members.exists({
      where: { communityId: community.id, userId },
    });
    if (!isOnRoster) {
      throw membersOnlyException();
    }
    const query = this.gifts
      .createQueryBuilder('gift')
      .where('gift.communityId = :communityId', { communityId: community.id })
      .andWhere('gift.recipientId = :userId', { userId })
      .andWhere('gift.removedAt IS NULL')
      .orderBy('gift.sentAt', 'DESC')
      .addOrderBy('gift.id', 'DESC');
    return paginate(query, pageFromQuery(page), async (rows) => {
      const sendersByUserId = await this.sendersFor(rows);
      return rows.map((gift) =>
        toCommunityShelfGiftDTO(
          gift,
          gift.senderId !== null
            ? (sendersByUserId.get(gift.senderId) ?? null)
            : null,
        ),
      );
    });
  }

  /** Route 10: the recipient hides or unhides a gift mark. Anyone else, a
   * removed gift or a malformed id answers `gift_not_found`. */
  async setHidden(
    slug: string,
    userId: string,
    giftId: string,
    body: UpdateCommunityGiftDto,
  ): Promise<CommunityShelfGiftDTO> {
    const { community } = await resolveForAnyCaller(this.accessDeps, {
      slug,
      userId,
      isWrite: true,
    });
    if (!isCommunityBadgeUuid(giftId)) {
      throw communityBadgeError('gift_not_found');
    }
    const gift = await this.gifts.findOne({
      where: {
        id: giftId,
        communityId: community.id,
        recipientId: userId,
        removedAt: IsNull(),
      },
    });
    if (!gift) {
      throw communityBadgeError('gift_not_found');
    }
    const shouldHide = normalizeGiftHidden(body.isHidden);
    const isHidden = gift.hiddenByRecipientAt !== null;
    if (shouldHide !== isHidden) {
      const hiddenByRecipientAt = shouldHide ? new Date() : null;
      const result = await this.gifts.update(
        { id: gift.id, removedAt: IsNull() },
        { hiddenByRecipientAt },
      );
      if (!result.affected) {
        throw communityBadgeError('gift_not_found');
      }
      gift.hiddenByRecipientAt = hiddenByRecipientAt;
    }
    const sendersByUserId = await this.sendersFor([gift]);
    return toCommunityShelfGiftDTO(
      gift,
      gift.senderId !== null
        ? (sendersByUserId.get(gift.senderId) ?? null)
        : null,
    );
  }

  /** Route 11: the sender (while still on the roster) or an owner-level
   * caller removes a gift for everyone, and the note leaves the recipient's
   * notification. A removed gift, a gift of another community or a malformed
   * id answers `gift_not_found`. */
  async remove(
    slug: string,
    userId: string,
    giftId: string,
  ): Promise<{ id: string }> {
    const { community, role } = await resolveForAnyCaller(this.accessDeps, {
      slug,
      userId,
      isWrite: true,
    });
    if (!isCommunityBadgeUuid(giftId)) {
      throw communityBadgeError('gift_not_found');
    }
    const gift = await this.gifts.findOne({
      where: { id: giftId, communityId: community.id, removedAt: IsNull() },
    });
    if (!gift) {
      throw communityBadgeError('gift_not_found');
    }
    const isSenderOnRoster = gift.senderId === userId && role !== null;
    const isOwnerLevel = role !== null && isCommunityOwnerLevelRole(role);
    if (!isSenderOnRoster && !isOwnerLevel) {
      throw communityBadgeError('gift_remove_not_allowed');
    }
    await this.dataSource.transaction(async (manager) => {
      const result = await manager
        .getRepository(CommunityGift)
        .update(
          { id: gift.id, removedAt: IsNull() },
          { removedAt: new Date(), removedById: userId },
        );
      if (!result.affected) {
        throw communityBadgeError('gift_not_found');
      }
      // The note leaves the recipient's bell with the gift, on this same
      // transaction.
      await scrubGiftNoteFromRecipientNotification(
        manager,
        gift.id,
        gift.recipientId,
      );
      await this.governanceLog.log(
        {
          communityId: community.id,
          actorUserId: userId,
          action: GovernanceLogAction.GiftRemoved,
          targetUserId: gift.recipientId,
          metadata: { giftId: gift.id, giftKey: gift.giftKey },
        },
        manager,
      );
    });
    return { id: gift.id };
  }

  /** Route 12: the visible gift marks of one member, newest first, at most
   * 50. No sender and no note. The roster's rules apply: a visitor of a
   * community whose roster is private to members, an unknown slug, a member
   * off the roster, a viewer below staff blocked either way with the member,
   * and a member the roster hides (paused, suspended, or hidden for 24h) all
   * get an empty list. The member themself always sees their own marks. */
  async listMemberMarks(
    slug: string,
    viewerId: string,
    memberSlug: string,
  ): Promise<{ gifts: CommunityMemberGiftDTO[] }> {
    const { community, role } = await resolveForBoardRead(this.accessDeps, {
      slug,
      userId: viewerId,
    });
    // A roster private to members stays closed to a visitor, the same gate
    // `CommunitiesService.roster` applies after the tier gate.
    if (role === null && !community.rosterVisible) {
      return { gifts: [] };
    }
    const memberId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (memberId === null) {
      return { gifts: [] };
    }
    const isMemberOnRoster = await this.members.exists({
      where: { communityId: community.id, userId: memberId },
    });
    if (!isMemberOnRoster) {
      return { gifts: [] };
    }
    const isViewerStaff = role !== null && isCommunityStaffRole(role);
    if (
      !isViewerStaff &&
      (await this.blockFilter.isBlockedEitherWay(viewerId, memberId))
    ) {
      return { gifts: [] };
    }
    const marksQuery = this.gifts
      .createQueryBuilder('gift')
      .select(['gift.id', 'gift.giftKey', 'gift.sentAt', 'gift.senderId'])
      .where('gift.communityId = :communityId', { communityId: community.id })
      .andWhere('gift.recipientId = :memberId', { memberId })
      .andWhere('gift.removedAt IS NULL')
      .andWhere('gift.hiddenByRecipientAt IS NULL')
      .andWhere(`"gift"."sent_at" > now() - interval '7 days'`);
    // Every viewer, staff included, loses the marks of a member the roster
    // hides, inside the query; the member reading their own marks skips it.
    if (memberId !== viewerId) {
      marksQuery.andWhere(MEMBER_MARKS_RECIPIENT_LISTED_SQL, {
        markMemberActiveStatus: UserStatus.Active,
      });
    }
    const marks = await marksQuery
      .orderBy('gift.sentAt', 'DESC')
      .addOrderBy('gift.id', 'DESC')
      .limit(COMMUNITY_MEMBER_GIFT_MARKS_LIMIT)
      .getMany();
    const isViewerOwnerLevel = role !== null && isCommunityOwnerLevelRole(role);
    // Route 11 lets the sender remove only while still on the roster, so an
    // ex-member sender sees no remove action.
    const isViewerSenderOnRoster = (gift: CommunityGift) =>
      gift.senderId === viewerId && role !== null;
    return {
      gifts: marks.map((gift) =>
        toCommunityMemberGiftDTO(
          gift,
          isViewerSenderOnRoster(gift) || isViewerOwnerLevel,
        ),
      ),
    };
  }

  /** The allowance of one sender in one community, read outside any
   * transaction. */
  private async readAllowance(
    communityId: string,
    senderId: string,
  ): Promise<CommunityGiftAllowanceDTO> {
    const rows = await this.dataSource.query<AllowanceRow[]>(ALLOWANCE_SQL, [
      communityId,
      senderId,
    ]);
    return allowanceFromRows(rows);
  }

  /** The senders of a page of gifts in one lookup. A missing or erased
   * sender is absent from the map. */
  private async sendersFor(
    gifts: CommunityGift[],
  ): Promise<Map<string, MemberRef>> {
    const senderIds = [
      ...new Set(
        gifts
          .map((gift) => gift.senderId)
          .filter((senderId): senderId is string => senderId !== null),
      ),
    ];
    return new MemberLookup(this.profiles).byUserIds(senderIds);
  }

  /** Tell the recipient about a gift. The sender is the actor, so a block or
   * mute of the sender drops the row. A failure is logged and swallowed. */
  private async notifyRecipient(
    community: Community,
    gift: CommunityGift,
    senderId: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        gift.recipientId,
        NotificationType.CommunityGiftReceived,
        {
          communitySlug: community.slug,
          communityName: community.name,
          giftId: gift.id,
          giftKey: gift.giftKey,
          note: gift.note,
          senderId,
        },
        senderId,
      );
    } catch (error) {
      this.logger.error(
        `Gift ${gift.id} was sent and the recipient notification failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
