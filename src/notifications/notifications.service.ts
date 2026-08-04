import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Mute } from '../social/entities/mute.entity';
import { Profile } from '../users/entities/profile.entity';
import { Notification, NotificationType } from './entities/notification.entity';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  NOTIFICATION_CREATED,
  NotificationCreatedEvent,
} from './notification.events';
import {
  NotificationResponse,
  actorIdOf,
  toNotificationResponse,
} from './notification-response';
import { PAGE_SIZE, Paginated, normalizePage } from '../common/pagination';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(Mute)
    private readonly mutes: Repository<Mute>,
    private readonly eventEmitter: EventEmitter2,
    private readonly blockFilter: BlockFilterService,
    private readonly notificationPreferences: NotificationPreferencesService,
  ) {}

  /**
   * Creates a notification for `userId`, unless `actorId` (the member whose
   * action triggered it) is hidden from the recipient — blocked in either
   * direction, or muted by the recipient. Returns `null` when suppressed.
   *
   * ENFORCEMENT POINT — write time, not read time. Three reasons this is the
   * right side of the line:
   *  1. `announce()` pushes every persisted notification straight to the
   *     recipient's live sockets (`notification:new`, via the chat gateway).
   *     A read-time filter in `list()` could never unring that bell — the
   *     blocked member's name would still pop up in real time. Suppressing the
   *     write suppresses the push too, because the push hangs off the write.
   *  2. The actor is buried in `payload` under a per-type key
   *     (`fromUserId` / `byUserId` / `voucherId` / `senderId` / `inviterId`),
   *     so a read-time filter would have to reverse-engineer JSON by
   *     `NotificationType` and silently miss any type added later. At write
   *     time each caller already holds the actor id as a typed value.
   *  3. `unreadCount()` is a separate query from `list()`; filtering at read
   *     time means keeping two independent filters in sync or shipping a badge
   *     count that never matches the list below it.
   * The trade-off — notifications created *before* a block are not
   * retroactively hidden — is consistent with how blocks behave elsewhere and
   * is why this is enforcement, not history rewriting.
   */
  async create(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
    actorId?: string,
  ): Promise<Notification | null> {
    if (actorId && (await this.isHiddenFrom(userId, actorId))) {
      return null;
    }
    // Per-type preference gate (after block/mute, which is a safety control the
    // member can't override). A recipient who turned this category off gets no
    // row — and so no live `notification:new` push, since that hangs off the
    // write, exactly like the block gate above.
    if (!(await this.notificationPreferences.isInAppEnabled(userId, type))) {
      return null;
    }
    const saved = await this.notifications.save(
      this.notifications.create({ userId, type, payload }),
    );
    this.announce(saved);
    return saved;
  }

  /**
   * Fan-out sibling of `create`, with the same write-time actor filter
   * applied per recipient (a block/mute is one recipient's relationship, so
   * it must never suppress the notification for everybody else).
   *
   * Returns the `userId`s a row was actually saved for (post block/mute
   * filter) — callers that fire a *second*, different notification off the
   * same event (e.g. forum reply-to-parent-author, alongside this reply's
   * `@mention` fan-out) can check this set first and skip a recipient who
   * already got one, instead of double-notifying/double-pushing them.
   */
  async createForRecipients(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown> = {},
    actorId?: string,
  ): Promise<string[]> {
    const visible = actorId
      ? await this.visibleRecipients(userIds, actorId)
      : userIds;
    // Drop recipients who turned this category off (batched, one query). The
    // block/mute filter above is a safety control; this is the member's own
    // preference — both narrow the same fan-out before any row is written.
    const recipients =
      await this.notificationPreferences.recipientsInAppEnabled(visible, type);
    if (!recipients.length) {
      return [];
    }
    const saved = await this.notifications.save(
      recipients.map((userId) =>
        this.notifications.create({ userId, type, payload }),
      ),
    );
    for (const notification of saved) {
      this.announce(notification);
    }
    return saved.map((notification) => notification.userId);
  }

  async list(
    userId: string,
    opts: { unread?: boolean; page?: number } = {},
  ): Promise<Paginated<NotificationResponse>> {
    const page = normalizePage(opts.page);
    const where = { userId, ...(opts.unread ? { read: false } : {}) };
    // Canonical offset envelope (`{items,total,page,pageSize}`, see
    // `common/pagination.ts`) instead of the old bespoke `{items,page,hasMore}`:
    // `total` is authoritative (the client derives "has a next page" from
    // `page * pageSize < total`) and a `(createdAt DESC, id DESC)` tiebreaker
    // keeps offset paging deterministic so no same-millisecond row is silently
    // skipped or repeated between pages. The count runs alongside the page read.
    const [rows, total] = await Promise.all([
      this.notifications.find({
        where,
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.notifications.count({ where }),
    ]);
    return {
      items: await this.attachActors(rows),
      total,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  /**
   * Resolve each row's acting member into an `actor` (name, slug, avatar) for
   * display. One batched profile query per page, not one per row. Rows with no
   * actor — or whose actor's profile is gone — keep `actor: null` and still
   * render through their generic copy.
   */
  private async attachActors(
    rows: Notification[],
  ): Promise<NotificationResponse[]> {
    const actorIds = [
      ...new Set(rows.map(actorIdOf).filter((id): id is string => id !== null)),
    ];
    const profiles = actorIds.length
      ? await this.profiles.find({ where: { userId: In(actorIds) } })
      : [];
    const byUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    return rows.map((row) => {
      const actorId = actorIdOf(row);
      return toNotificationResponse(
        row,
        actorId ? byUserId.get(actorId) : undefined,
      );
    });
  }

  unreadCount(userId: string): Promise<number> {
    return this.notifications.count({ where: { userId, read: false } });
  }

  async markRead(id: string, userId: string): Promise<{ ok: true }> {
    const result = await this.notifications.update(
      { id, userId },
      { read: true },
    );
    if (!result.affected) {
      throw new NotFoundException('Notification not found');
    }
    return { ok: true };
  }

  async markAllRead(userId: string): Promise<{ ok: true }> {
    await this.notifications.update({ userId, read: false }, { read: true });
    return { ok: true };
  }

  /**
   * `true` when `actorId`'s actions must not reach `recipientId`: blocked in
   * either direction (hard severance), or muted by the recipient — mutes are
   * one-way and `BlockFilterService.isMutedBy`'s docstring names "notifications
   * skipped" as exactly what a mute does. A member is never hidden from
   * themself (both helpers short-circuit on equal ids), so self-notifications
   * still go through.
   */
  private async isHiddenFrom(
    recipientId: string,
    actorId: string,
  ): Promise<boolean> {
    const [blocked, muted] = await Promise.all([
      this.blockFilter.isBlockedEitherWay(recipientId, actorId),
      this.blockFilter.isMutedBy(recipientId, actorId),
    ]);
    return blocked || muted;
  }

  /**
   * The fan-out equivalent of `isHiddenFrom`, computed in **two batched
   * queries total** rather than `2 × userIds.length`: one either-way `blocks`
   * lookup (reusing `BlockFilterService.blockedUserIds`) and one directional
   * `mutes` lookup. A recipient is dropped when the actor is blocked either way
   * relative to them, or when they have muted the actor. The actor is never
   * hidden from themself — self-ids are excluded from both lookups, so a
   * self-notification still passes through, exactly as the per-recipient
   * `isHiddenFrom` behaved. Duplicates and ordering in `userIds` are
   * preserved.
   */
  private async visibleRecipients(
    userIds: string[],
    actorId: string,
  ): Promise<string[]> {
    const recipientIdsToCheck = [...new Set(userIds)].filter(
      (recipientId) => recipientId !== actorId,
    );
    const [blockedRecipientIds, mutingRecipientIds] = await Promise.all([
      // Blocked either way relative to the actor — already one batched query.
      this.blockFilter.blockedUserIds(actorId, recipientIdsToCheck),
      this.recipientsMuting(actorId, recipientIdsToCheck),
    ]);
    return userIds.filter(
      (recipientId) =>
        !blockedRecipientIds.has(recipientId) &&
        !mutingRecipientIds.has(recipientId),
    );
  }

  /**
   * The subset of `recipientIds` that have muted `actorId` — rows where the
   * recipient is the muter and the actor the muted. This is the mirror of
   * `BlockFilterService.mutedUserIds` (which finds who the *actor* muted), so
   * that helper cannot serve it; one batched query in the `In(...)` style of
   * `attachActors`.
   */
  private async recipientsMuting(
    actorId: string,
    recipientIds: string[],
  ): Promise<Set<string>> {
    if (!recipientIds.length) {
      return new Set();
    }
    const muteRows = await this.mutes.find({
      where: { muterId: In(recipientIds), mutedId: actorId },
      select: { muterId: true },
    });
    return new Set(muteRows.map((muteRow) => muteRow.muterId));
  }

  /**
   * Announce a persisted notification on the internal event bus. The chat
   * gateway listens and pushes it to the recipient's live sockets as
   * `notification:new`; emitting only after the write means a pushed
   * notification always has a row behind it.
   *
   * `emit` is synchronous and fire-and-forget — a listener that throws must
   * never fail the write that produced the notification.
   */
  private announce(notification: Notification): void {
    const event: NotificationCreatedEvent = {
      userId: notification.userId,
      notification,
    };
    this.eventEmitter.emit(NOTIFICATION_CREATED, event);
  }
}
