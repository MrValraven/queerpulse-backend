import { Injectable, Optional } from '@nestjs/common';
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
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { EventAudienceGateService } from '../events/event-audience-gate.service';
import { PAGE_SIZE, Paginated, normalizePage } from '../common/pagination';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { loadMatchedChatMentionRenderer } from '../messaging/matched-chat-mention-text';
import { hasMatchedChatMentions } from '../messaging/matched-member-key';
import {
  MentionResolvers,
  MentionResponse,
  toMentionResponse,
} from './dto/mention-response';
import { EVENT_MODERATION_SUBJECT_TYPE } from './mention-notification.service';
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
 * mirroring `NotificationsService.attachActors`. A page holding `event`
 * mentions (a gathering's description) adds the batched gathering read of
 * `readableMentionEvents`.
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
    // Holds an `event` mention's label and excerpt to the gatherings this
    // member can still open (`readableMentionEvents`). `MentionsModule`
    // always provides it; a construction without it (a unit fixture) serves
    // no gathering label or excerpt, the closed reading.
    @Optional()
    private readonly eventAudience?: EventAudienceGateService,
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
      items: await this.mapRows(rows, userId),
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

  private async mapRows(
    rows: Notification[],
    userId: string,
  ): Promise<MentionResponse[]> {
    const actorIds = collectPayloadStrings(rows, 'actorId');
    const threadSlugs = collectPayloadStrings(rows, 'threadSlug');
    const communitySlugs = collectPayloadStrings(rows, 'communitySlug');
    const eventSlugs = collectPayloadStrings(
      rows.filter((row) => row.payload?.source === 'event'),
      'eventSlug',
    );

    const [profiles, threadRows, communityRows, readableEvents] =
      await Promise.all([
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
        this.readableMentionEvents(eventSlugs, userId),
      ]);

    // A gathering this member can no longer open serves no excerpt either:
    // it is left out of `events`, which the freshness check reads as gone.
    const staleExcerptNotificationIds = await staleMentionExcerptIds(
      rows,
      this.dataSource,
      {
        threads: threadRows,
        communities: communityRows,
        events: readableEvents.map(({ event }) => event),
      },
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
      eventTitleBySlug: new Map(
        readableEvents
          .filter(({ isTakenDown }) => !isTakenDown)
          .map(({ event }) => [event.slug, event.title]),
      ),
      staleExcerptNotificationIds,
    };

    const readableRows = await this.withReadableMatchedChatExcerpts(rows);
    return readableRows.map((row) => toMentionResponse(row, resolvers));
  }

  /**
   * The published gatherings among `eventSlugs` that `userId` can still open
   * by their audience tier (`EventAudienceGateService.filterViewable`, the
   * batched form of the detail page's gate), each with whether a platform
   * moderator took it down. A takedown hides the label here; the freshness
   * check blanks the excerpt for it on its own read. A draft or cancelled
   * gathering never loads. Two queries plus the gate's own batched reads,
   * and none when the page holds no `event` mention.
   */
  private async readableMentionEvents(
    eventSlugs: string[],
    userId: string,
  ): Promise<Array<{ event: Event; isTakenDown: boolean }>> {
    if (!eventSlugs.length || !this.eventAudience) return [];
    const eventAudience = this.eventAudience;
    const eventRows = await this.dataSource.getRepository(Event).find({
      where: { slug: In(eventSlugs), status: EventStatus.Published },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        hostId: true,
        visibility: true,
        communityId: true,
      },
    });
    if (!eventRows.length) return [];
    const [viewableEvents, moderationRows] = await Promise.all([
      eventAudience.filterViewable(eventRows, userId),
      this.dataSource.getRepository(ContentModeration).find({
        where: {
          subjectType: EVENT_MODERATION_SUBJECT_TYPE,
          subjectId: In(eventRows.map((event) => event.id)),
        },
        select: { subjectId: true, hiddenAt: true, removedAt: true },
      }),
    ]);
    const takenDownEventIds = new Set(
      moderationRows
        .filter((row) => !!row.hiddenAt || !!row.removedAt)
        .map((row) => row.subjectId),
    );
    return viewableEvents.map((event) => ({
      event,
      isTakenDown: takenDownEventIds.has(event.id),
    }));
  }

  /**
   * PRD-423 (opaque member keys): a mention written in a matched Go together
   * chat (`payload.isGoTogetherChat`) carries an excerpt whose `@` mentions
   * are opaque per-chat keys. Those are spelled `@FirstName` here, for every
   * such row on the page in two batched reads; the stored payload is never
   * rewritten, and a page with no such excerpt reads nothing.
   */
  private async withReadableMatchedChatExcerpts(
    rows: Notification[],
  ): Promise<Notification[]> {
    const matchedConversationIds = rows.flatMap((row) => {
      const conversationId = row.payload?.conversationId;
      const excerpt = row.payload?.excerpt;
      return row.payload?.isGoTogetherChat === true &&
        typeof conversationId === 'string' &&
        typeof excerpt === 'string' &&
        hasMatchedChatMentions(excerpt)
        ? [conversationId]
        : [];
    });
    if (!matchedConversationIds.length) return rows;
    const render = await loadMatchedChatMentionRenderer(
      {
        participants: this.dataSource.getRepository(ConversationParticipant),
        profiles: this.profiles,
      },
      matchedConversationIds,
    );
    return rows.map((row) => {
      const conversationId = row.payload?.conversationId;
      const excerpt = row.payload?.excerpt;
      if (
        row.payload?.isGoTogetherChat !== true ||
        typeof conversationId !== 'string' ||
        typeof excerpt !== 'string'
      ) {
        return row;
      }
      return {
        ...row,
        payload: { ...row.payload, excerpt: render(conversationId, excerpt) },
      };
    });
  }
}
