import { NotFoundException } from '@nestjs/common';
import { seatExcludedFromMailboxPredicate } from '../messaging/mailbox-seats';
import {
  AccountService,
  archivedThreadConversationIds,
} from './account.service';
import {
  DataExportFormat,
  DataExportJob,
  DataExportStatus,
} from './entities/data-export-job.entity';

/**
 * Task 13g, audit gap G6: an archive built just before a customer blocked a
 * staff member still carried that customer's thread (a reported thread's
 * messages, a mention's excerpt) and stayed downloadable, and reusable, for
 * its whole link window. The archive is refused once the block rule takes the
 * exporter out of a conversation it copied content from.
 */

const EXPORTER = 'staff-1';
const BLOCKED_THREAD = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

function readyJob(data: Record<string, unknown>): DataExportJob {
  return {
    id: 'job-1',
    userId: EXPORTER,
    status: DataExportStatus.Ready,
    categories: ['messages', 'notifications'],
    format: DataExportFormat.Json,
    requestedAt: new Date(),
    generatedAt: new Date(),
    data,
    error: null,
  };
}

const archiveWithBlockedThread = {
  reportedConversations: [
    {
      conversationId: BLOCKED_THREAD,
      conversationTitle: 'Jamie',
      messages: [],
    },
  ],
  notifications: [
    {
      id: 'notification-1',
      payload: { conversationId: BLOCKED_THREAD, excerpt: 'my booking' },
    },
  ],
};

function buildService(options: {
  job: DataExportJob;
  isOvertakenByBlock: boolean;
}) {
  const query = jest
    .fn()
    .mockResolvedValue([
      { isArchiveOvertakenByMailboxExclusion: options.isOvertakenByBlock },
    ]);
  const exportJobs = {
    findOne: jest.fn().mockResolvedValue(options.job),
    save: jest.fn((row: Record<string, unknown>) =>
      Promise.resolve({ id: 'job-2', ...row }),
    ),
  };
  const exportService = {
    knownCategories: jest.fn(() => ['messages', 'notifications']),
    build: jest.fn().mockResolvedValue({ fresh: true }),
  };
  const service = Object.assign(Object.create(AccountService.prototype), {
    exportJobs,
    exportService,
    dataSource: { query },
    assertReauth: jest.fn().mockResolvedValue(undefined),
  }) as AccountService;
  return { service, query, exportJobs, exportService };
}

describe('archivedThreadConversationIds', () => {
  it('reads reported threads and notification payloads, and drops malformed ids', () => {
    expect(
      archivedThreadConversationIds({
        reportedConversations: [{ conversationId: BLOCKED_THREAD }],
        notifications: [
          { payload: { conversationId: 'not-a-uuid' } },
          { payload: null },
        ],
        messages: [{ conversationId: '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b' }],
      }),
    ).toEqual([BLOCKED_THREAD]);
  });
});

describe('getExportDownload, Task 13g G6', () => {
  it('refuses an archive the block rule has since overtaken, with the plain expiry copy', async () => {
    const { service } = buildService({
      job: readyJob(archiveWithBlockedThread),
      isOvertakenByBlock: true,
    });

    await expect(service.getExportDownload(EXPORTER, 'job-1')).rejects.toThrow(
      new NotFoundException(
        'This export download link has expired. Request a new export to download your data again.',
      ),
    );
  });

  it('serves the same archive when no block has overtaken it', async () => {
    const { service } = buildService({
      job: readyJob(archiveWithBlockedThread),
      isOvertakenByBlock: false,
    });

    await expect(
      service.getExportDownload(EXPORTER, 'job-1'),
    ).resolves.toMatchObject({ kind: 'json' });
  });

  it("asks the shared block predicate about the exporter's own seat in each archived thread", async () => {
    const { service, query } = buildService({
      job: readyJob(archiveWithBlockedThread),
      isOvertakenByBlock: false,
    });

    await service.getExportDownload(EXPORTER, 'job-1');

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      seatExcludedFromMailboxPredicate(
        '"archived_seat"."conversation_id"',
        '"archived_seat"."user_id"',
      ),
    );
    expect(parameters).toEqual([EXPORTER, [BLOCKED_THREAD]]);
  });

  it('costs no query for an archive that copied no thread content', async () => {
    const { service, query } = buildService({
      job: readyJob({ profile: { firstName: 'Sam' } }),
      isOvertakenByBlock: true,
    });

    await service.getExportDownload(EXPORTER, 'job-1');

    expect(query).not.toHaveBeenCalled();
  });
});

describe('requestExport reuse, Task 13g G6', () => {
  it('builds a fresh archive when the block rule has overtaken the recent one', async () => {
    const { service, exportService } = buildService({
      job: readyJob(archiveWithBlockedThread),
      isOvertakenByBlock: true,
    });

    await service.requestExport(EXPORTER, {
      reauthToken: 'token',
      categories: ['messages', 'notifications'],
      format: DataExportFormat.Json,
    });

    expect(exportService.build).toHaveBeenCalledTimes(1);
  });

  it('still reuses a recent archive no block has overtaken', async () => {
    const { service, exportService } = buildService({
      job: readyJob(archiveWithBlockedThread),
      isOvertakenByBlock: false,
    });

    await service.requestExport(EXPORTER, {
      reauthToken: 'token',
      categories: ['messages', 'notifications'],
      format: DataExportFormat.Json,
    });

    expect(exportService.build).not.toHaveBeenCalled();
  });
});
