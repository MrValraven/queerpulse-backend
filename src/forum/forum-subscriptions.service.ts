import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { ForumThreadSubscription } from './entities/forum-thread-subscription.entity';

/**
 * How many subscribers one reply may notify. A thread everybody follows would
 * otherwise turn a single reply into an unbounded notification fan-out on the
 * request path. Well above any realistic follower count for a thread, low
 * enough that a runaway thread cannot stall a reply.
 */
const MAX_NOTIFIED_SUBSCRIBERS = 500;

/**
 * Thread following AND the read watermark (SOC-13, then C7/PRD-170): who hears
 * about new replies on a forum thread, and where each member had read to.
 *
 * Following used to be a bare existence check — a row exists or it does not.
 * It is now the row's `is_following` flag, because the same table also carries
 * `last_read_at` and a member who merely OPENED a thread must not come out of
 * it subscribed to every reply (see `ForumThreadSubscription`). Two
 * consequences run through every method here:
 *
 *  - every read filters `is_following = true`, never `EXISTS`;
 *  - `unsubscribe` clears the flag instead of deleting the row, so unfollowing
 *    does not also throw away where the member had read to.
 *
 * Every write is still best-effort from the caller's point of view: a follow
 * that fails must never take a reply or a thread creation down with it, so
 * `subscribeQuietly` swallows and logs. The explicit Follow/Unfollow toggle
 * uses `subscribe`/`unsubscribe`, which do surface their errors — a member who
 * taps Follow deserves to be told it did not work.
 */
@Injectable()
export class ForumSubscriptionsService {
  private readonly logger = new Logger(ForumSubscriptionsService.name);

  constructor(
    @InjectRepository(ForumThreadSubscription)
    private readonly subscriptions: Repository<ForumThreadSubscription>,
  ) {}

  /**
   * Is this member following this thread? `is_following`, not existence: a row
   * can now be a read watermark on a thread the member never followed.
   */
  async isSubscribed(threadId: string, userId: string): Promise<boolean> {
    if (!userId) return false;
    return this.subscriptions.exists({
      where: { threadId, userId, isFollowing: true },
    });
  }

  /**
   * Batched sibling of `isSubscribed` for a page of threads: one
   * `user_id = :viewer AND thread_id IN (...)` query, backed by the primary
   * key, instead of one existence probe per row. Returns the subset of
   * `threadIds` the viewer follows.
   */
  async subscribedThreadIds(
    threadIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    if (!userId || !threadIds.length) return new Set();
    const rows = await this.subscriptions.find({
      where: { userId, threadId: In(threadIds), isFollowing: true },
      select: ['threadId'],
    });
    return new Set(rows.map((row) => row.threadId));
  }

  /**
   * Follow a thread. Idempotent: a repeat follow writes the same value it
   * already holds, never a read-then-write race between two tabs.
   *
   * `ON CONFLICT DO UPDATE`, not `DO NOTHING`, since the watermark landed
   * (C7/PRD-170): a member who has only ever OPENED this thread already has a
   * row, carrying `is_following = false`. `DO NOTHING` would leave that row
   * exactly as it was and the Follow tap would do nothing at all. Only the flag
   * is written on conflict, so following a thread never disturbs the watermark
   * underneath it.
   *
   * Takes an optional `EntityManager` so an auto-subscribe can commit inside
   * the same transaction as the reply that triggered it.
   */
  async subscribe(
    threadId: string,
    userId: string,
    existingManager?: EntityManager,
  ): Promise<void> {
    const repository = existingManager
      ? existingManager.getRepository(ForumThreadSubscription)
      : this.subscriptions;
    await repository
      .createQueryBuilder()
      .insert()
      .into(ForumThreadSubscription)
      .values({ threadId, userId, isFollowing: true })
      .orUpdate(['is_following'], ['thread_id', 'user_id'])
      .execute();
  }

  /**
   * Stamp the member's read watermark on this thread (C7/PRD-170) — "I have
   * seen the thread as it stands right now".
   *
   * Creates the row when there is none, and this is the ONE write here that
   * must not sign anybody up for anything: `is_following` is written `false` on
   * INSERT and left completely alone on conflict. Opening a thread is not
   * asking to be notified about it, and a watermark that quietly subscribed
   * would turn reading five threads into five threads' worth of bell.
   */
  async markRead(threadId: string, userId: string): Promise<void> {
    await this.subscriptions
      .createQueryBuilder()
      .insert()
      .into(ForumThreadSubscription)
      .values({ threadId, userId, isFollowing: false, lastReadAt: new Date() })
      .orUpdate(['last_read_at'], ['thread_id', 'user_id'])
      .execute();
  }

  /**
   * Auto-subscribe on a domain action the member did not ask a follow for
   * (starting a thread, posting a reply). Never throws: the thread or reply has
   * already committed by the time this runs, so a failed follow must not turn a
   * successful post into a 500.
   */
  async subscribeQuietly(threadId: string, userId: string): Promise<void> {
    try {
      await this.subscribe(threadId, userId);
    } catch (error) {
      this.logger.warn(
        `Failed to auto-subscribe ${userId} to forum thread ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Unfollow a thread. A no-op when there was no row.
   *
   * Clears the flag rather than deleting the row (C7/PRD-170): the row also
   * carries `last_read_at`, and deleting it would reset the member's unread
   * badge on a thread they merely stopped wanting notifications about, so
   * everything posted before the unfollow would come back as new.
   */
  async unsubscribe(threadId: string, userId: string): Promise<void> {
    await this.subscriptions.update(
      { threadId, userId },
      { isFollowing: false },
    );
  }

  /**
   * The members to notify about a new reply: everyone following the thread
   * except the replier themselves. Capped at `MAX_NOTIFIED_SUBSCRIBERS` oldest
   * followers first, so the people who committed to the thread earliest are the
   * ones a runaway thread keeps notifying.
   */
  async subscriberIdsToNotify(
    threadId: string,
    excludeUserId: string,
  ): Promise<string[]> {
    const rows = await this.subscriptions.find({
      where: { threadId, isFollowing: true },
      select: ['userId'],
      order: { createdAt: 'ASC' },
      take: MAX_NOTIFIED_SUBSCRIBERS + 1,
    });
    return rows
      .map((row) => row.userId)
      .filter((userId) => userId !== excludeUserId)
      .slice(0, MAX_NOTIFIED_SUBSCRIBERS);
  }
}
