import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
// TypeORM's update mapped type rejects a plain `Record<string, unknown>` for a
// jsonb column: it has no index signature the type can recurse into (the same
// snag documented in `community-governance-log.service.ts`). The two bundle
// writes below need `update`/`set` rather than `save`, because they bump a
// `@CreateDateColumn` and increment a counter in SQL, so the patch object is
// asserted to this type instead of being reshaped.
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  CommunityMember,
  CommunityNotificationLevel,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Mute } from '../social/entities/mute.entity';
import { Profile } from '../users/entities/profile.entity';
import { Notification, NotificationType } from './entities/notification.entity';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  NOTIFICATION_BUNDLE_WINDOW_MS,
  bundleKeyFor,
} from './notification-bundling';
import {
  NOTIFICATION_BATCH_CREATED,
  NOTIFICATION_CREATED,
  NotificationBatchCreatedEvent,
  NotificationCreatedEvent,
} from './notification.events';
import {
  NotificationResponse,
  actorIdOf,
  toNotificationResponse,
} from './notification-response';
import { PAGE_SIZE, Paginated, normalizePage } from '../common/pagination';

/**
 * Which per-community levels still want each community-chatter type. A type
 * absent from this table is NEVER gated on a community level: see
 * `NotificationsService.communityGatedRecipients` for why that has to be a
 * whitelist.
 */
const COMMUNITY_LEVELS_WANTING: Partial<
  Record<NotificationType, readonly CommunityNotificationLevel[]>
> = {
  [NotificationType.CommunityNewPost]: [CommunityNotificationLevel.All],
  [NotificationType.CommunityResourceAdded]: [CommunityNotificationLevel.All],
  [NotificationType.CommunityReply]: [CommunityNotificationLevel.All],
  [NotificationType.CommunityAnnouncement]: [
    CommunityNotificationLevel.All,
    CommunityNotificationLevel.Announcements,
  ],
};

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(Mute)
    private readonly mutes: Repository<Mute>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
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
    // Per-community volume, on top of the platform-wide category gate above: a
    // member who set this community to "announcements only" or muted it gets no
    // row for its ordinary chatter. Governance and safety types are never gated
    // this way — see `communityGatedRecipients`.
    const [stillWanted] = await this.communityGatedRecipients(
      [userId],
      type,
      payload,
    );
    if (!stillWanted) {
      return null;
    }
    // Collapse onto an existing unread row for the same subject when there is
    // one, so forty replies to one thread stay one row (see
    // `notification-bundling.ts`).
    const bundled = await this.absorbIntoBundle(userId, type, payload);
    if (bundled) {
      this.announce(bundled);
      this.announceBatch([userId], type, payload, actorId ?? null, bundled);
      return bundled;
    }
    const saved = await this.notifications.save(
      this.notifications.create({
        userId,
        type,
        payload,
        bundleKey: bundleKeyFor(type, payload),
      }),
    );
    this.announce(saved);
    this.announceBatch([userId], type, payload, actorId ?? null, saved);
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
    const categoryEnabled =
      await this.notificationPreferences.recipientsInAppEnabled(visible, type);
    // Per-community volume, batched across the whole fan-out (one extra query
    // for the community, one for the roster levels, regardless of recipient
    // count).
    const recipients = await this.communityGatedRecipients(
      categoryEnabled,
      type,
      payload,
    );
    if (!recipients.length) {
      return [];
    }
    // Recipients who already hold an unread row for this subject absorb the
    // event instead of gaining a second row. Two queries for the whole batch:
    // one to find those rows, one to bump them.
    const absorbed = await this.absorbIntoBundlesForRecipients(
      recipients,
      type,
      payload,
    );
    const freshRecipients = recipients.filter(
      (userId) => !absorbed.has(userId),
    );
    const bundleKey = bundleKeyFor(type, payload);
    const inserted = freshRecipients.length
      ? await this.notifications.save(
          freshRecipients.map((userId) =>
            this.notifications.create({ userId, type, payload, bundleKey }),
          ),
        )
      : [];
    const saved = [...absorbed.values(), ...inserted];
    for (const notification of saved) {
      this.announce(notification);
    }
    // One batch announcement for the whole write, alongside the per-row
    // `announce()` loop above — see `NOTIFICATION_BATCH_CREATED`'s docstring
    // for why these are two different events with two different listeners.
    // `saved[0]` is the batch's shared representative row; `recipients.length`
    // was already checked non-empty above, so `saved` is never empty either.
    const [representative] = saved;
    if (representative) {
      this.announceBatch(
        recipients,
        type,
        payload,
        actorId ?? null,
        representative,
      );
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

  // --- Bundling -------------------------------------------------------------

  /**
   * Fold a new event into `userId`'s existing unread row for the same subject,
   * returning the updated row, or `null` when there is nothing to fold into and
   * the caller should insert normally.
   *
   * Written as an explicit `update()` rather than `save()` on the loaded entity
   * because `createdAt` is a `@CreateDateColumn`: TypeORM populates it on insert
   * and leaves it alone on update, so bumping it needs to be stated as a column
   * to SET. The in-memory row is patched to match, since it is what gets
   * announced to the socket and the push listener.
   */
  private async absorbIntoBundle(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<Notification | null> {
    const bundleKey = bundleKeyFor(type, payload);
    if (!bundleKey) return null;
    const existing = await this.notifications.findOne({
      where: {
        userId,
        type,
        bundleKey,
        read: false,
        createdAt: MoreThan(this.bundleCutoff()),
      },
      order: { createdAt: 'DESC' },
    });
    if (!existing) return null;
    const now = new Date();
    const otherActorCount = existing.otherActorCount + 1;
    await this.notifications.update({ id: existing.id }, {
      payload,
      otherActorCount,
      createdAt: now,
    } as QueryDeepPartialEntity<Notification>);
    existing.payload = payload;
    existing.otherActorCount = otherActorCount;
    existing.createdAt = now;
    return existing;
  }

  /**
   * The fan-out sibling of `absorbIntoBundle`: every recipient who already holds
   * an unread row for this subject, mapped to their updated row.
   *
   * Two queries for the whole batch rather than two per recipient. The count is
   * incremented in SQL (`other_actor_count + 1`) instead of being read and
   * written back, so two overlapping fan-outs cannot both write the same value
   * and lose one of the events.
   */
  private async absorbIntoBundlesForRecipients(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<Map<string, Notification>> {
    const absorbed = new Map<string, Notification>();
    const bundleKey = bundleKeyFor(type, payload);
    if (!bundleKey || !userIds.length) return absorbed;
    const rows = await this.notifications.find({
      where: {
        userId: In([...new Set(userIds)]),
        type,
        bundleKey,
        read: false,
        createdAt: MoreThan(this.bundleCutoff()),
      },
      order: { createdAt: 'DESC' },
    });
    // One row per recipient: `find` is ordered newest-first, so the first row
    // seen for a recipient is the one that absorbs. A recipient with older
    // duplicates (written before this table had a bundle key) keeps them; they
    // age out through the retention sweep rather than being rewritten here.
    for (const row of rows) {
      if (!absorbed.has(row.userId)) absorbed.set(row.userId, row);
    }
    if (!absorbed.size) return absorbed;
    const now = new Date();
    await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({
        payload,
        createdAt: now,
        otherActorCount: () => '"other_actor_count" + 1',
      } as QueryDeepPartialEntity<Notification>)
      .whereInIds([...absorbed.values()].map((row) => row.id))
      .execute();
    for (const row of absorbed.values()) {
      row.payload = payload;
      row.otherActorCount += 1;
      row.createdAt = now;
    }
    return absorbed;
  }

  /** The oldest `createdAt` an unread row may have and still absorb an event. */
  private bundleCutoff(): Date {
    return new Date(Date.now() - NOTIFICATION_BUNDLE_WINDOW_MS);
  }

  // --- Per-community volume --------------------------------------------------

  /**
   * The subset of `userIds` whose own level for the community this notification
   * belongs to still wants it.
   *
   * Applies ONLY to the four community-chatter types below. It is a whitelist,
   * never a blocklist, and that is the load-bearing detail: `source: 'community'`
   * is also on the payload of "you were banned", "your role changed", "the
   * community was archived". Gating those on a level would let muting a room
   * silence the news that you are no longer in it, which is exactly the kind of
   * thing a mute must never be able to do.
   *
   * The levels mirror `CommunityPostsService`'s existing fan-out filter, so a
   * post filtered there and a reply filtered here answer to the same setting:
   *  - `all`: everything.
   *  - `announcements`: only what an owner or mod marked as an announcement.
   *  - `mentions`: none of these. `Mention` is not in this set and is never
   *    gated, so being named still reaches the member.
   *  - `muted`: none of these.
   *
   * Fails OPEN at every step. A payload with no `communitySlug`, a slug that no
   * longer resolves, or a recipient with no roster row all keep the notification:
   * a bell that rings when it was unsure is recoverable, silence is not.
   */
  private async communityGatedRecipients(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    const levels = COMMUNITY_LEVELS_WANTING[type];
    if (!levels || !userIds.length) return userIds;
    const slug = payload?.communitySlug;
    if (typeof slug !== 'string' || !slug) return userIds;
    const community = await this.communities.findOne({
      where: { slug },
      select: { id: true },
    });
    if (!community) return userIds;
    const memberships = await this.communityMembers.find({
      where: {
        communityId: community.id,
        userId: In([...new Set(userIds)]),
      },
      select: { userId: true, notificationLevel: true },
    });
    const levelByUserId = new Map(
      memberships.map((membership) => [
        membership.userId,
        membership.notificationLevel,
      ]),
    );
    return userIds.filter((userId) => {
      const level = levelByUserId.get(userId);
      // No roster row: not a member of this community, so this level cannot
      // speak for them. Keep the notification.
      if (level === undefined) return true;
      return levels.includes(level);
    });
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

  /**
   * Announce one notification-type WRITE (as opposed to `announce()` above,
   * which announces one persisted ROW). `PushNotificationListener` consumes
   * only this event: one batch, however many recipients it holds, becomes one
   * category-preference query, one shared-actor lookup, and one
   * `pushService.sendToUsers(allRecipientIds)` call — instead of doing all
   * three per recipient, which is what looping `announce()` alone produced
   * for a many-recipient fan-out (e.g. an event update pushed to every RSVP).
   */
  private announceBatch(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown>,
    actorId: string | null,
    representative: Notification,
  ): void {
    const event: NotificationBatchCreatedEvent = {
      userIds,
      type,
      payload,
      actorId,
      notification: representative,
    };
    this.eventEmitter.emit(NOTIFICATION_BATCH_CREATED, event);
  }
}
