import { NotificationType } from '../notifications/entities/notification.entity';
import { FundingDeadlineReminderService } from './funding-deadline-reminder.service';
import { forumThreadVisibleSql } from './forum-threads.service';
import { fundingSaverVisibleSql } from './funding-saver-visibility';

// 09:00 in Lisbon (summer time) on 5 October 2026.
const NOW = new Date('2026-10-05T08:00:00.000Z');
const SEVEN_DAYS_OUT = new Date('2026-10-12T20:00:00.000Z');
const EXTENDED_SEVEN_DAYS_OUT = new Date('2026-10-12T21:30:00.000Z');
const TOMORROW = new Date('2026-10-06T21:00:00.000Z');
const THREE_DAYS_OUT = new Date('2026-10-08T12:00:00.000Z');
const LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;

function candidateRow(userId: string, threadId: string, deadline: Date) {
  return {
    user_id: userId,
    thread_id: threadId,
    thread_slug: `${threadId}-slug`,
    thread_title: `Call ${threadId}`,
    deadline,
  };
}

function buildService() {
  const reminders = { query: jest.fn() };
  const notifications = {
    createForRecipients: jest.fn((userIds: string[]) =>
      Promise.resolve(userIds),
    ),
  };
  const service = new FundingDeadlineReminderService(
    reminders as never,
    notifications as never,
  );
  return { service, reminders, notifications };
}

describe('FundingDeadlineReminderService', () => {
  it('reads only saved, live, visible and unmoderated calls inside the lookahead', async () => {
    const { service, reminders } = buildService();
    reminders.query.mockResolvedValueOnce([]);

    await service.runReminderPass(NOW);

    const [candidateSql, candidateParameters] = reminders.query.mock
      .calls[0] as [string, unknown[]];
    expect(candidateSql).toContain(`"thread"."kind" = 'call'`);
    expect(candidateSql).toContain('"thread"."deleted_at" IS NULL');
    expect(candidateSql).toContain(forumThreadVisibleSql('"thread"'));
    expect(candidateSql).toContain('"saved"."subject_id" = "thread"."slug"');
    expect(candidateSql).toContain('"moderation"."hidden_at" IS NOT NULL');
    expect(candidateSql).toContain('"block"."blocker_id"');
    expect(candidateSql).toContain(
      fundingSaverVisibleSql('"thread"', '"saved"'),
    );
    expect(candidateSql).toContain('"community_members" "membership"');
    expect(candidateSql).toContain('"own_pm"."user_id" = "saved"."user_id"');
    expect(candidateSql).toContain('"staff_pm"."user_id" = "saved"."user_id"');
    expect(candidateSql).toContain("AT TIME ZONE 'Europe/Lisbon'");
    expect(candidateSql).toContain(') IN (1, 7)');
    expect(candidateSql).toContain('NOT EXISTS');
    expect(candidateSql).toContain('"funding_deadline_reminder" "sent"');
    expect(candidateParameters).toEqual([
      NOW,
      new Date(NOW.getTime() + LOOKAHEAD_MS),
      2000,
    ]);
  });

  it('notifies only the reminders the insert actually claimed', async () => {
    const { service, reminders, notifications } = buildService();
    reminders.query
      .mockResolvedValueOnce([
        candidateRow('user-1', 'thread-1', SEVEN_DAYS_OUT),
        candidateRow('user-2', 'thread-1', SEVEN_DAYS_OUT),
      ])
      .mockResolvedValueOnce([
        { user_id: 'user-2', thread_id: 'thread-1', stage: '7d' },
      ]);

    const remindedCount = await service.runReminderPass(NOW);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-2'],
      NotificationType.FundingDeadlineSoon,
      {
        source: 'forum',
        threadSlug: 'thread-1-slug',
        threadTitle: 'Call thread-1',
        deadline: SEVEN_DAYS_OUT.toISOString(),
        stage: '7d',
      },
    );
    expect(remindedCount).toBe(1);
  });

  it('sends one notification per call and stage with every claimed saver', async () => {
    const { service, reminders, notifications } = buildService();
    reminders.query
      .mockResolvedValueOnce([
        candidateRow('user-1', 'thread-1', SEVEN_DAYS_OUT),
        candidateRow('user-2', 'thread-1', SEVEN_DAYS_OUT),
        candidateRow('user-3', 'thread-2', TOMORROW),
      ])
      .mockResolvedValueOnce([
        { user_id: 'user-1', thread_id: 'thread-1', stage: '7d' },
        { user_id: 'user-2', thread_id: 'thread-1', stage: '7d' },
        { user_id: 'user-3', thread_id: 'thread-2', stage: '1d' },
      ]);

    await service.runReminderPass(NOW);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(2);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-1', 'user-2'],
      NotificationType.FundingDeadlineSoon,
      expect.objectContaining({ stage: '7d', threadSlug: 'thread-1-slug' }),
    );
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-3'],
      NotificationType.FundingDeadlineSoon,
      expect.objectContaining({ stage: '1d', threadSlug: 'thread-2-slug' }),
    );
  });

  it('claims nothing for a deadline that is neither seven days nor one day away', async () => {
    const { service, reminders, notifications } = buildService();
    reminders.query.mockResolvedValueOnce([
      candidateRow('user-1', 'thread-1', THREE_DAYS_OUT),
    ]);

    await service.runReminderPass(NOW);

    expect(reminders.query).toHaveBeenCalledTimes(1);
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('writes the deadline into the claim so an extended call earns fresh reminders', async () => {
    const { service, reminders, notifications } = buildService();
    reminders.query
      .mockResolvedValueOnce([
        candidateRow('user-1', 'thread-1', EXTENDED_SEVEN_DAYS_OUT),
      ])
      .mockResolvedValueOnce([
        { user_id: 'user-1', thread_id: 'thread-1', stage: '7d' },
      ]);

    await service.runReminderPass(NOW);

    const [insertSql, insertParameters] = reminders.query.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(insertSql).toContain('ON CONFLICT DO NOTHING');
    expect(insertSql).toContain('RETURNING');
    expect(insertParameters).toEqual([
      ['user-1'],
      ['thread-1'],
      ['7d'],
      [EXTENDED_SEVEN_DAYS_OUT.toISOString()],
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-1'],
      NotificationType.FundingDeadlineSoon,
      expect.objectContaining({
        deadline: EXTENDED_SEVEN_DAYS_OUT.toISOString(),
      }),
    );
  });

  it('sends nothing on a rerun whose claims all conflict', async () => {
    const { service, reminders, notifications } = buildService();
    reminders.query
      .mockResolvedValueOnce([
        candidateRow('user-1', 'thread-1', SEVEN_DAYS_OUT),
      ])
      .mockResolvedValueOnce([]);

    expect(await service.runReminderPass(NOW)).toBe(0);
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('keeps going after one notification fails', async () => {
    const { service, reminders, notifications } = buildService();
    reminders.query
      .mockResolvedValueOnce([
        candidateRow('user-1', 'thread-1', SEVEN_DAYS_OUT),
        candidateRow('user-3', 'thread-2', TOMORROW),
      ])
      .mockResolvedValueOnce([
        { user_id: 'user-1', thread_id: 'thread-1', stage: '7d' },
        { user_id: 'user-3', thread_id: 'thread-2', stage: '1d' },
      ]);
    notifications.createForRecipients
      .mockRejectedValueOnce(new Error('notifications table locked'))
      .mockResolvedValueOnce(['user-3']);

    expect(await service.runReminderPass(NOW)).toBe(1);
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(2);
  });

  it('swallows a failing sweep in the cron entry point', async () => {
    const { service, reminders } = buildService();
    reminders.query.mockRejectedValueOnce(new Error('database restarting'));

    await expect(service.sendDueReminders()).resolves.toBeUndefined();
  });

  it('warns when the candidate read reaches the cap', async () => {
    const { service, reminders } = buildService();
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    reminders.query.mockResolvedValueOnce(
      Array.from({ length: 2000 }, (_unused, index) =>
        candidateRow(`user-${index}`, 'thread-1', THREE_DAYS_OUT),
      ),
    );

    await service.runReminderPass(NOW);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps running the next batch after one batch fails', async () => {
    const { service, reminders, notifications } = buildService();
    const rows = Array.from({ length: 501 }, (_unused, index) =>
      candidateRow(`user-${index}`, `thread-${index}`, SEVEN_DAYS_OUT),
    );
    reminders.query
      .mockResolvedValueOnce(rows)
      .mockRejectedValueOnce(new Error('foreign key violation'))
      .mockResolvedValueOnce([
        { user_id: 'user-500', thread_id: 'thread-500', stage: '7d' },
      ]);

    expect(await service.runReminderPass(NOW)).toBe(1);
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
  });
});
