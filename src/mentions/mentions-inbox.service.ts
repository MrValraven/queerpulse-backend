import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { Profile } from '../users/entities/profile.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Community } from '../communities/entities/community.entity';
import { PAGE_SIZE, Paginated, normalizePage } from '../common/pagination';
import {
  MentionResolvers,
  MentionResponse,
  toMentionResponse,
} from './dto/mention-response';

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
  ) {}

  async list(
    userId: string,
    opts: { unread?: boolean; page?: number } = {},
  ): Promise<Paginated<MentionResponse>> {
    const page = normalizePage(opts.page);
    const where = {
      userId,
      type: NotificationType.Mention,
      ...(opts.unread ? { read: false } : {}),
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
   * broader `POST /notifications/read-all` would).
   */
  async markAllRead(userId: string): Promise<{ ok: true }> {
    await this.notifications.update(
      { userId, type: NotificationType.Mention, read: false },
      { read: true },
    );
    return { ok: true };
  }

  private async mapRows(rows: Notification[]): Promise<MentionResponse[]> {
    const actorIds = collectStrings(rows, 'actorId');
    const threadSlugs = collectStrings(rows, 'threadSlug');
    const communitySlugs = collectStrings(rows, 'communitySlug');

    const [profiles, threadRows, communityRows] = await Promise.all([
      actorIds.length
        ? this.profiles.find({ where: { userId: In(actorIds) } })
        : Promise.resolve([] as Profile[]),
      threadSlugs.length
        ? this.threads.find({
            where: { slug: In(threadSlugs) },
            select: { slug: true, title: true },
          })
        : Promise.resolve([] as ForumThread[]),
      communitySlugs.length
        ? this.communities.find({
            where: { slug: In(communitySlugs) },
            select: { slug: true, name: true },
          })
        : Promise.resolve([] as Community[]),
    ]);

    const resolvers: MentionResolvers = {
      profileByUserId: new Map(
        profiles.map((profile) => [profile.userId, profile]),
      ),
      threadTitleBySlug: new Map(
        threadRows.map((thread) => [thread.slug, thread.title]),
      ),
      communityNameBySlug: new Map(
        communityRows.map((community) => [community.slug, community.name]),
      ),
    };

    return rows.map((row) => toMentionResponse(row, resolvers));
  }
}

/** Distinct, defined string values of one payload key across the page's rows. */
function collectStrings(rows: Notification[], key: string): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.payload?.[key])
        .filter(
          (value): value is string => typeof value === 'string' && !!value,
        ),
    ),
  ];
}
