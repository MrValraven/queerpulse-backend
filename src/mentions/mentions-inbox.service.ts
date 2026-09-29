import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { visibleThroughMailboxSeatRules } from '../notifications/notification-mailbox-block';
import { visibleThroughActorBlocks } from '../notifications/notification-actor-block';
import {
  NOTIFICATION_STATE_CHANGED,
  NotificationStateChangedEvent,
} from '../notifications/notification.events';
import { Profile } from '../users/entities/profile.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Community } from '../communities/entities/community.entity';
import { PAGE_SIZE, Paginated, normalizePage } from '../common/pagination';
import {
  MentionResolvers,
  MentionResponse,
  toMentionResponse,
} from './dto/mention-response';
import {
  collectPayloadStrings,
  isReadableThread,
  staleMentionExcerptIds,
} from './mention-stale-excerpts';

/**
 * Read side of the `@`-mentions feature — the inbox `MentionNotificationService`
 * (the write/fan-out side) never had. There is no mentions table: a mention is
 * persisted only as a `NotificationType.Mention` row, so this reads exactly
 * those rows for the current member and hand-maps each to a `MentionResponse`.
 *
 * Two batched enrichment queries per page (never one-per-row): the actor
 * profiles behind the rows' `payload.actorId`, and the source labels (forum
 * thread titles / community names) behind their `threadSlug`/`communitySlug` —
 * mirroring `NotificationsService.attachActors`.
 *
 * ENG-411: a third batched step checks each row's source (one query per
 * source kind, see `staleMentionExcerptIds`, which the data export shares)
 * so an excerpt whose words were deleted, edited or taken down is served
 * empty. The post, reply and message repositories are reached through the
 * `DataSource` so this read adds no entity registrations to `MentionsModule`.
 */
@Injectable()
export class MentionsInboxService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async list(
    userId: string,
    opts: { unread?: boolean; page?: number } = {},
  ): Promise<Paginated<MentionResponse>> {
    const page = normalizePage(opts.page);
    // Task 13g: a mention written inside a business mailbox thread before
    // this member was blocked out of it carries an excerpt of that thread,
    // so it stays out of the inbox, and out of `total`, while the block
    // stands (`visibleThroughMailboxSeatRules`). Task 14a: the same holds
    // after this member leaves the business, while they stay away. PRD-403:
    // a mention whose author is blocked either way with this member stays
    // out too, and out of `total`, while that block stands.
    const where = {
      userId,
      type: NotificationType.Mention,
      id: visibleThroughActorBlocks(userId),
      ...(opts.unread ? { read: false } : {}),
      payload: visibleThroughMailboxSeatRules(userId),
    };
    // Same canonical offset envelope + `(createdAt DESC, id DESC)` deterministic
    // tiebreaker as `NotificationsService.list`, so no same-millisecond row is
    // skipped or repeated across pages. Count runs alongside the page read.
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
      items: await this.mapRows(rows),
      total,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  /**
   * Mark every one of the member's mentions read — scoped to
   * `NotificationType.Mention` so the mentions inbox's "mark all read" never
   * silently clears the member's other notification categories (which the
   * broader `POST /notifications/read-all` would). Also composes the same
   * `visibleThroughMailboxSeatRules` filter `list` reads through: without it,
   * a mention a mailbox block currently hides still gets `read: true` here,
   * so lifting the block later resurfaces a row the member never actually
   * saw, already marked read. PRD-403: the actor block filter is composed
   * for the same reason.
   */
  async markAllRead(userId: string): Promise<{ ok: true }> {
    const result = await this.notifications.update(
      {
        userId,
        type: NotificationType.Mention,
        id: visibleThroughActorBlocks(userId),
        read: false,
        payload: visibleThroughMailboxSeatRules(userId),
      },
      { read: true },
    );
    // Mention rows are bell rows too, so the member's other tabs and devices
    // refetch their bell once this write actually changed something.
    if ((result.affected ?? 0) > 0) {
      const event: NotificationStateChangedEvent = { userId };
      this.eventEmitter.emit(NOTIFICATION_STATE_CHANGED, event);
    }
    return { ok: true };
  }

  private async mapRows(rows: Notification[]): Promise<MentionResponse[]> {
    const actorIds = collectPayloadStrings(rows, 'actorId');
    const threadSlugs = collectPayloadStrings(rows, 'threadSlug');
    const communitySlugs = collectPayloadStrings(rows, 'communitySlug');

    const [profiles, threadRows, communityRows] = await Promise.all([
      actorIds.length
        ? this.profiles.find({ where: { userId: In(actorIds) } })
        : Promise.resolve([] as Profile[]),
      threadSlugs.length
        ? this.threads.find({
            // A withdrawn thread's title never resolves here (PRD-160). The
            // mention row survives its thread, so without this the inbox went
            // on rendering the title of a thread its author had retracted, to
            // exactly the person named in it. An unresolved slug falls through
            // `toMentionResponse`'s existing "no source label" path, which is
            // what a mention whose source is gone should read as.
            where: { slug: In(threadSlugs), deletedAt: IsNull() },
            select: { id: true, slug: true, title: true, reviewState: true },
          })
        : Promise.resolve([] as ForumThread[]),
      communitySlugs.length
        ? this.communities.find({
            where: { slug: In(communitySlugs) },
            select: {
              slug: true,
              name: true,
              archivedAt: true,
              parentId: true,
            },
          })
        : Promise.resolve([] as Community[]),
    ]);

    const staleExcerptNotificationIds = await staleMentionExcerptIds(
      rows,
      this.dataSource,
      { threads: threadRows, communities: communityRows },
    );

    const resolvers: MentionResolvers = {
      profileByUserId: new Map(
        profiles.map((profile) => [profile.userId, profile]),
      ),
      // A thread moved to rejected or pending after the mention names a
      // place the member can no longer open, so its title stays unresolved,
      // the same list the excerpt check reads.
      threadTitleBySlug: new Map(
        threadRows
          .filter(isReadableThread)
          .map((thread) => [thread.slug, thread.title]),
      ),
      communityNameBySlug: new Map(
        communityRows.map((community) => [community.slug, community.name]),
      ),
      staleExcerptNotificationIds,
    };

    return rows.map((row) => toMentionResponse(row, resolvers));
  }
}
