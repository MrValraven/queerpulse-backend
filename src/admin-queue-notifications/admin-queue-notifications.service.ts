import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import {
  ADMIN_QUEUE_REGISTRY,
  AdminQueueKey,
  AdminQueueMeta,
} from './admin-queue.registry';

/**
 * Tells the staff who can work a queue that something has landed in it.
 *
 * One method, called from every creation site that puts a row into an admin
 * review queue. Before this, an arrival reached nobody: `report_filed` covers
 * reports alone, and `ModerationQueueAlertService` reports a queue's DEPTH
 * once an hour after a threshold is crossed, which is a different question. A
 * single verification request, DSAR, listing claim or magazine pitch produced
 * silence until somebody happened to open the console.
 *
 * WHO HEARS IT is resolved from `ADMIN_QUEUE_REGISTRY`, the mirror of the
 * frontend access map, so the bell and the rail agree: a `resource_curator`
 * hears about resource suggestions and never about DSAR, and the legal
 * register stays admin-only in both places.
 *
 * NO ACTOR ID is passed, deliberately, matching `ReportNotificationsListener`.
 * Duty mail must not be suppressible by a block or mute between the submitting
 * member and whoever is on shift, and the bell must never name the submitter.
 *
 * BEST EFFORT. Every failure is caught and logged. A notification failure must
 * never surface to the member who submitted, and must never fail the write
 * that produced it. This is the same contract `REPORT_CREATED` states.
 *
 * CALL IT AFTER THE ROW COMMITS. A call from inside an open transaction would
 * page staff about a row a rollback then removed.
 *
 * EXCLUDING A STAFF MEMBER: a permanent ban's ratification hold exists
 * precisely because the moderator who proposed it cannot also be its second
 * signature. Telling that moderator "a ban is waiting for a second look" is
 * noise, and worse, it reads as the platform not knowing who proposed it.
 * `excludeUserIds` removes any listed user from the resolved recipients after
 * both the tier and grant populations are gathered, so a caller with a
 * disqualified party in hand (the proposing moderator, for instance) can keep
 * them out of their own duty mail.
 */
@Injectable()
export class AdminQueueNotificationsService {
  private readonly logger = new Logger(AdminQueueNotificationsService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(UserStaffRole)
    private readonly staffGrants: Repository<UserStaffRole>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * @param queue which review queue received an item
   * @param itemId the row's id, stored for correlation. It is NOT forwarded to
   *   the client (see `PAYLOAD_ALLOWLIST`): the bell links to the queue, and
   *   the item is read behind the console's own authentication.
   * @param excludeUserIds staff who must not hear about this particular
   *   arrival, even though they can otherwise work the queue. See the
   *   ratification example on the class docstring.
   */
  async announce(
    queue: AdminQueueKey,
    itemId?: string,
    excludeUserIds?: readonly string[],
  ): Promise<void> {
    try {
      const queueMeta = ADMIN_QUEUE_REGISTRY[queue];
      if (!queueMeta) return;
      const resolvedRecipientIds = await this.resolveRecipients(queueMeta);
      const excludedUserIds = new Set(excludeUserIds ?? []);
      const recipientIds = resolvedRecipientIds.filter(
        (recipientId) => !excludedUserIds.has(recipientId),
      );
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.AdminQueueItem,
        {
          source: 'admin',
          queue,
          ...(itemId ? { itemId } : {}),
        },
      );
    } catch (error) {
      this.logger.warn(
        `admin queue notification failed for ${queue}: ${String(error)}`,
      );
    }
  }

  /**
   * The union of two populations, both filtered to active accounts so a
   * suspended or deactivated staff member stops receiving duty mail the moment
   * their account changes state:
   *
   *  1. The account TIER the queue requires.
   *  2. Holders of any additive staff GRANT that reaches the queue on its own.
   *
   * The grant half runs only when the queue names a capability, so a queue
   * with none (the safe-space flag queue, the legal register) costs one query
   * rather than three.
   */
  private async resolveRecipients(
    queueMeta: AdminQueueMeta,
  ): Promise<string[]> {
    const tiers =
      queueMeta.tier === UserRole.Admin
        ? [UserRole.Admin]
        : [UserRole.Moderator, UserRole.Admin];
    const tierStaff = await this.users.find({
      where: { role: In(tiers), status: UserStatus.Active },
      select: { id: true },
    });
    const recipientIds = new Set(tierStaff.map((staffUser) => staffUser.id));

    if (queueMeta.capabilities.length) {
      const grants = await this.staffGrants.find({
        where: { role: In([...queueMeta.capabilities]) },
        select: { userId: true },
      });
      const candidateIds = [
        ...new Set(grants.map((grant) => grant.userId)),
      ].filter((userId) => !recipientIds.has(userId));
      if (candidateIds.length) {
        // A grant row outlives the account's status, so the holders are
        // re-checked for `active` rather than trusted from the grant alone.
        const activeHolders = await this.users.find({
          where: { id: In(candidateIds), status: UserStatus.Active },
          select: { id: true },
        });
        for (const holder of activeHolders) recipientIds.add(holder.id);
      }
    }

    return [...recipientIds];
  }
}
