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
 * Thread following (SOC-13): who hears about new replies on a forum thread.
 *
 * Following is idempotent and binary — a row exists or it does not (see
 * `ForumThreadSubscription`). Every write here is best-effort from the caller's
 * point of view: a follow that fails must never take a reply or a thread
 * creation down with it, so `subscribeQuietly` swallows and logs. The explicit
 * Follow/Unfollow toggle uses `subscribe`/`unsubscribe`, which do surface their
 * errors — a member who taps Follow deserves to be told it did not work.
 */
@Injectable()
export class ForumSubscriptionsService {
  private readonly logger = new Logger(ForumSubscriptionsService.name);

  constructor(
    @InjectRepository(ForumThreadSubscription)
    private readonly subscriptions: Repository<ForumThreadSubscription>,
  ) {}

  /** Is this member following this thread? */
  async isSubscribed(threadId: string, userId: string): Promise<boolean> {
    if (!userId) return false;
    return this.subscriptions.exists({ where: { threadId, userId } });
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
      where: { userId, threadId: In(threadIds) },
      select: ['threadId'],
    });
    return new Set(rows.map((row) => row.threadId));
  }

  /**
   * Follow a thread. Idempotent: a repeat follow is an `ON CONFLICT DO NOTHING`
   * insert, never a read-then-write race between two tabs.
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
      .values({ threadId, userId })
      .orIgnore()
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

  /** Unfollow a thread. A no-op when there was no subscription. */
  async unsubscribe(threadId: string, userId: string): Promise<void> {
    await this.subscriptions.delete({ threadId, userId });
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
      where: { threadId },
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
