import { FindOperator } from 'typeorm';
import type { FindManyOptions, FindOptionsWhere } from 'typeorm';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { visibleThroughMailboxSeatRules } from '../notifications/notification-mailbox-block';
import { MentionsInboxService } from './mentions-inbox.service';

const now = new Date('2026-08-05T10:00:00.000Z');

function mentionRow(
  id: string,
  payload: Record<string, unknown> = {},
): Notification {
  return {
    id,
    userId: 'me',
    type: NotificationType.Mention,
    read: false,
    createdAt: now,
    payload,
    bundleKey: null,
    otherActorCount: 0,
  };
}

function build() {
  const notifications = {
    find: jest
      .fn<Promise<Notification[]>, [FindManyOptions<Notification>]>()
      .mockResolvedValue([]),
    count: jest
      .fn<Promise<number>, [FindManyOptions<Notification>]>()
      .mockResolvedValue(0),
    // The service discards `update`'s resolved value, so the mock's return
    // type is left as `unknown` rather than faking a real `UpdateResult`.
    update: jest
      .fn<
        Promise<unknown>,
        [FindOptionsWhere<Notification>, Partial<Notification>]
      >()
      .mockResolvedValue(undefined),
  };
  const profiles = { find: jest.fn().mockResolvedValue([]) };
  const threads = { find: jest.fn().mockResolvedValue([]) };
  const communities = { find: jest.fn().mockResolvedValue([]) };

  const service = new MentionsInboxService(
    notifications as never,
    profiles as never,
    threads as never,
    communities as never,
  );
  return { service, notifications, profiles, threads, communities };
}

describe('MentionsInboxService', () => {
  describe('list', () => {
    it('scopes to the caller and to Mention rows, with the canonical page envelope', async () => {
      const { service, notifications } = build();
      notifications.find.mockResolvedValue([mentionRow('n1')]);
      notifications.count.mockResolvedValue(1);

      const result = await service.list('me', { page: 2 });

      // `service.list` always calls `notifications.find` exactly once above.
      const findArgs = notifications.find.mock.calls[0]![0];
      // Task 13g: plus the mailbox block visibility condition on `payload`.
      expect(findArgs.where).toEqual({
        userId: 'me',
        type: NotificationType.Mention,
        payload: expect.any(FindOperator),
      });
      expect(findArgs.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
      expect(findArgs.skip).toBe(20); // (page 2 - 1) * PAGE_SIZE
      expect(findArgs.take).toBe(20);
      expect(result).toMatchObject({ total: 1, page: 2, pageSize: 20 });
      expect(result.items).toHaveLength(1);
    });

    it('adds the unread predicate only when requested', async () => {
      const { service, notifications } = build();

      await service.list('me', { unread: true });

      expect(notifications.find.mock.calls[0]![0].where).toEqual({
        userId: 'me',
        type: NotificationType.Mention,
        read: false,
        payload: expect.any(FindOperator),
      });
    });

    it('normalises an absent/invalid page to 1', async () => {
      const { service, notifications } = build();

      const result = await service.list('me', {});

      expect(notifications.find.mock.calls[0]![0].skip).toBe(0);
      expect(result.page).toBe(1);
    });

    it('enriches actors/threads/communities in one batched query each', async () => {
      const { service, notifications, profiles, threads, communities } =
        build();
      notifications.find.mockResolvedValue([
        mentionRow('n1', {
          actorId: 'actor-1',
          source: 'forum',
          threadSlug: 'welcome',
        }),
        mentionRow('n2', {
          actorId: 'actor-1', // duplicate actor -> deduped in the IN list
          source: 'community',
          communitySlug: 'pride',
        }),
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'actor-1',
          slug: 'ada',
          firstName: 'Ada',
          lastName: 'L',
          avatarUrl: null,
        },
      ]);
      threads.find.mockResolvedValue([{ slug: 'welcome', title: 'Welcome' }]);
      communities.find.mockResolvedValue([{ slug: 'pride', name: 'Pride' }]);

      const result = await service.list('me', {});

      expect(profiles.find).toHaveBeenCalledTimes(1);
      expect(threads.find).toHaveBeenCalledTimes(1);
      expect(communities.find).toHaveBeenCalledTimes(1);
      expect(result.items[0]!.actor?.slug).toBe('ada');
      expect(result.items[0]!.sourceLabel).toBe('Welcome');
      expect(result.items[1]!.sourceLabel).toBe('Pride');
    });

    it('skips enrichment queries entirely when the page has no such refs', async () => {
      const { service, notifications, profiles, threads, communities } =
        build();
      notifications.find.mockResolvedValue([mentionRow('n1', {})]);

      await service.list('me', {});

      expect(profiles.find).not.toHaveBeenCalled();
      expect(threads.find).not.toHaveBeenCalled();
      expect(communities.find).not.toHaveBeenCalled();
    });
  });

  describe('markAllRead', () => {
    it('marks read scoped to Mention only, never other categories', async () => {
      const { service, notifications } = build();

      const result = await service.markAllRead('me');

      const [criteria, patch] = notifications.update.mock.calls[0]!;
      expect(criteria).toMatchObject({
        userId: 'me',
        type: NotificationType.Mention,
        read: false,
      });
      expect(patch).toEqual({ read: true });
      expect(result).toEqual({ ok: true });
    });

    // CW-22: without this filter, a mention a mailbox block currently hides
    // from `list` still got marked read here, so lifting the block later
    // resurfaced a row the member never actually saw, already marked read.
    it('composes the same mailbox block visibility filter list uses, on the payload column', async () => {
      const { service, notifications } = build();

      await service.markAllRead('me');

      const [criteria] = notifications.update.mock.calls[0]!;
      const payloadCondition = (criteria as { payload: FindOperator<unknown> })
        .payload;
      const expectedCondition = visibleThroughMailboxSeatRules('me');
      expect(payloadCondition).toBeInstanceOf(FindOperator);
      expect(payloadCondition.getSql?.('Notification.payload')).toBe(
        expectedCondition.getSql?.('Notification.payload'),
      );
      expect(payloadCondition.objectLiteralParameters).toEqual(
        expectedCondition.objectLiteralParameters,
      );
    });
  });
});
