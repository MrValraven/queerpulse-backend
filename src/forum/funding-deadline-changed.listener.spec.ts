import { NotificationType } from '../notifications/entities/notification.entity';
import { ForumFundingDeadlineChangedEvent } from './forum.events';
import { FundingDeadlineChangedListener } from './funding-deadline-changed.listener';
import { fundingSaverVisibleSql } from './funding-saver-visibility';

const movedDeadline: ForumFundingDeadlineChangedEvent = {
  threadId: 'thread-1',
  threadSlug: 'arts-grant',
  threadTitle: 'Arts grant',
  authorId: 'author-1',
  editorId: 'author-1',
  deadline: '2026-12-15T23:59:00.000Z',
};

function buildListener(saverIds: string[]) {
  const savedItems = {
    query: jest
      .fn()
      .mockResolvedValue(saverIds.map((userId) => ({ user_id: userId }))),
  };
  const notifications = {
    createForRecipients: jest.fn().mockResolvedValue([]),
  };
  const listener = new FundingDeadlineChangedListener(
    savedItems as never,
    notifications as never,
  );
  return { listener, savedItems, notifications };
}

describe('FundingDeadlineChangedListener', () => {
  it('tells every saver once with the new date, filtering blocks and mutes against the author', async () => {
    const { listener, savedItems, notifications } = buildListener([
      'saver-1',
      'saver-2',
      'saver-1',
      'author-1',
    ]);

    await listener.onDeadlineChanged(movedDeadline);

    expect(savedItems.query).toHaveBeenCalledWith(expect.any(String), [
      'thread-1',
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['saver-1', 'saver-2'],
      NotificationType.FundingDeadlineChanged,
      {
        source: 'forum',
        threadSlug: 'arts-grant',
        threadTitle: 'Arts grant',
        deadline: '2026-12-15T23:59:00.000Z',
      },
      'author-1',
    );
  });

  it('resolves savers in one query with the funding visibility gates', async () => {
    const { listener, savedItems } = buildListener(['saver-1']);

    await listener.onDeadlineChanged(movedDeadline);

    const [saverSql] = savedItems.query.mock.calls[0] as [string];
    expect(saverSql).toContain(fundingSaverVisibleSql('"thread"', '"saved"'));
    expect(saverSql).toContain('"saved"."subject_id"');
    expect(saverSql).toContain('"moderation"."removed_at" IS NOT NULL');
    expect(saverSql).toContain('"moderation"."hidden_at" IS NOT NULL');
    expect(saverSql).toContain('"community_members" "membership"');
    expect(saverSql).toContain('"own_pm"."user_id" = "saved"."user_id"');
    expect(saverSql).toContain('"staff_pm"."user_id" = "saved"."user_id"');
    expect(saverSql).toContain('"block"."blocker_id"');
  });

  it('notifies nobody when the query returns no savers', async () => {
    const { listener, notifications } = buildListener([]);

    await listener.onDeadlineChanged(movedDeadline);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('leaves out the moderator who made the edit', async () => {
    const { listener, notifications } = buildListener([
      'moderator-1',
      'saver-1',
    ]);

    await listener.onDeadlineChanged({
      ...movedDeadline,
      editorId: 'moderator-1',
    });

    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['saver-1'],
      NotificationType.FundingDeadlineChanged,
      expect.any(Object),
      'author-1',
    );
  });

  it('sends nothing when the call became rolling', async () => {
    const { listener, savedItems, notifications } = buildListener(['saver-1']);

    await listener.onDeadlineChanged({ ...movedDeadline, deadline: null });

    expect(savedItems.query).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('sends nothing when only the author saved it', async () => {
    const { listener, notifications } = buildListener(['author-1']);

    await listener.onDeadlineChanged(movedDeadline);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('still tells savers when the author has erased their account', async () => {
    const { listener, notifications } = buildListener(['saver-1']);

    await listener.onDeadlineChanged({
      ...movedDeadline,
      authorId: null,
      editorId: 'moderator-1',
    });

    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['saver-1'],
      NotificationType.FundingDeadlineChanged,
      expect.any(Object),
      undefined,
    );
  });

  it('swallows a failed write', async () => {
    const { listener, notifications } = buildListener(['saver-1']);
    notifications.createForRecipients.mockRejectedValueOnce(
      new Error('notifications table locked'),
    );

    await expect(
      listener.onDeadlineChanged(movedDeadline),
    ).resolves.toBeUndefined();
  });
});
