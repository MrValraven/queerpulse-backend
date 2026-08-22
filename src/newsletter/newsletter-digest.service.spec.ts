import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MailerService } from '../mailer/mailer.service';
import { NewsletterDigestBatch } from './entities/newsletter-digest-batch.entity';
import { NewsletterDigestSend } from './entities/newsletter-digest-send.entity';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';
import { NewsletterDigestService } from './newsletter-digest.service';

/**
 * The claim in `claimBatch` goes through the raw `Repository.query()`, and for
 * a statement postgres reports as `UPDATE` the driver hands back
 * `[rows, affectedCount]` rather than the rows (see the `switch (raw.command)`
 * in typeorm's `PostgresQueryRunner.query`). Every test here feeds the drain
 * that exact shape, because reading it as a plain row array is the bug these
 * tests exist to keep out: it yielded two junk "rows" per tick (the nested
 * array and the count), both with `id: undefined`, so the queue never looked
 * empty and the first `sends.delete({ id: undefined })` threw before a single
 * message was sent, having already burned an attempt on 25 real ledger rows.
 */
const claimResult = (rows: unknown[]): [unknown[], number] => [
  rows,
  rows.length,
];

describe('NewsletterDigestService', () => {
  let service: NewsletterDigestService;
  let batches: { upsert: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let sends: {
    query: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let insertQueryBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
  };
  let subscriptions: { find: jest.Mock };
  let mailer: { send: jest.Mock };
  let loggedErrors: jest.SpyInstance;

  const batch = {
    id: 'batch-1',
    issueNumber: '12',
    issueTitle: 'Winter',
    items: [{ title: 'A piece', blurb: 'About something' }],
  };

  beforeEach(async () => {
    batches = {
      upsert: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(batch),
      find: jest.fn().mockResolvedValue([batch]),
    };
    insertQueryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    sends = {
      // Defaults to an empty queue, in the driver's own `UPDATE` shape.
      query: jest.fn().mockResolvedValue(claimResult([])),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(insertQueryBuilder),
    };
    subscriptions = { find: jest.fn().mockResolvedValue([]) };
    mailer = { send: jest.fn().mockResolvedValue(undefined) };
    // `drainQueuedDigests` swallows everything into `logger.error` so a cron
    // tick can never take the process down, which also means a regression
    // would show up ONLY here. Asserting on it is how these tests can tell
    // "delivered nothing because the queue was empty" from "threw".
    loggedErrors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NewsletterDigestService,
        {
          provide: getRepositoryToken(NewsletterDigestBatch),
          useValue: batches,
        },
        { provide: getRepositoryToken(NewsletterDigestSend), useValue: sends },
        {
          provide: getRepositoryToken(NewsletterSubscription),
          useValue: subscriptions,
        },
        { provide: MailerService, useValue: mailer },
      ],
    }).compile();
    service = module.get(NewsletterDigestService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('drainQueuedDigests', () => {
    it("mails a claimed row, mapping the claim's snake_case RETURNING columns", async () => {
      sends.query.mockResolvedValue(
        claimResult([
          {
            id: 'send-1',
            batch_id: 'batch-1',
            subscription_id: 'sub-1',
            attempts: 1,
          },
        ]),
      );
      subscriptions.find.mockResolvedValue([
        { id: 'sub-1', email: 'member@example.com', status: 'confirmed' },
      ]);

      await service.drainQueuedDigests();

      expect(loggedErrors).not.toHaveBeenCalled();
      expect(mailer.send).toHaveBeenCalledWith('member@example.com', 'digest', {
        issueNumber: '12',
        issueTitle: 'Winter',
        items: batch.items,
      });
      // Stamped against the row's REAL id, which is the value the driver's
      // `[rows, count]` wrapper used to swallow.
      expect(sends.update).toHaveBeenCalledWith(
        { id: 'send-1' },
        { sentAt: expect.any(Date) as unknown, lastError: null },
      );
    });

    it('treats a claim that returned no rows as an empty queue', async () => {
      // `[[], 0]` has length 2. A drain that measures the wrapper instead of
      // the rows reads that as two rows to deliver and works on garbage.
      sends.query.mockResolvedValue(claimResult([]));

      await service.drainQueuedDigests();

      expect(loggedErrors).not.toHaveBeenCalled();
      expect(batches.find).not.toHaveBeenCalled();
      expect(subscriptions.find).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
      expect(sends.delete).not.toHaveBeenCalled();
      expect(sends.update).not.toHaveBeenCalled();
    });

    it('drops the ledger row for an address that unsubscribed since queueing', async () => {
      sends.query.mockResolvedValue(
        claimResult([
          {
            id: 'send-1',
            batch_id: 'batch-1',
            subscription_id: 'sub-1',
            attempts: 1,
          },
        ]),
      );
      subscriptions.find.mockResolvedValue([
        { id: 'sub-1', email: 'gone@example.com', status: 'unsubscribed' },
      ]);

      await service.drainQueuedDigests();

      expect(mailer.send).not.toHaveBeenCalled();
      // The exact call that threw `Undefined value encountered in property
      // 'id' of a where condition`: it must carry a real id.
      expect(sends.delete).toHaveBeenCalledWith({ id: 'send-1' });
      expect(loggedErrors).not.toHaveBeenCalled();
    });

    it('retires a row whose batch has gone missing instead of retrying it', async () => {
      sends.query.mockResolvedValue(
        claimResult([
          {
            id: 'send-1',
            batch_id: 'batch-gone',
            subscription_id: 'sub-1',
            attempts: 1,
          },
        ]),
      );
      batches.find.mockResolvedValue([]);
      subscriptions.find.mockResolvedValue([
        { id: 'sub-1', email: 'member@example.com', status: 'confirmed' },
      ]);

      await service.drainQueuedDigests();

      expect(mailer.send).not.toHaveBeenCalled();
      expect(sends.update).toHaveBeenCalledWith(
        { id: 'send-1' },
        { attempts: 3, lastError: 'Digest batch is missing' },
      );
    });

    it('records a failed send and still delivers the rest of the batch', async () => {
      sends.query.mockResolvedValue(
        claimResult([
          {
            id: 'send-1',
            batch_id: 'batch-1',
            subscription_id: 'sub-1',
            attempts: 1,
          },
          {
            id: 'send-2',
            batch_id: 'batch-1',
            subscription_id: 'sub-2',
            attempts: 1,
          },
        ]),
      );
      subscriptions.find.mockResolvedValue([
        { id: 'sub-1', email: 'bounces@example.com', status: 'confirmed' },
        { id: 'sub-2', email: 'fine@example.com', status: 'confirmed' },
      ]);
      mailer.send.mockRejectedValueOnce(new Error('SMTP connect timeout'));

      await service.drainQueuedDigests();

      expect(sends.update).toHaveBeenCalledWith(
        { id: 'send-1' },
        { lastError: 'SMTP connect timeout' },
      );
      expect(mailer.send).toHaveBeenCalledWith(
        'fine@example.com',
        'digest',
        expect.anything(),
      );
      expect(sends.update).toHaveBeenCalledWith(
        { id: 'send-2' },
        { sentAt: expect.any(Date) as unknown, lastError: null },
      );
      // A per-row failure is a warning, never an escaped rejection.
      expect(loggedErrors).not.toHaveBeenCalled();
    });

    it('stands down when the previous tick is still draining', async () => {
      let releaseClaim: (result: [unknown[], number]) => void = () => undefined;
      sends.query.mockReturnValueOnce(
        new Promise<[unknown[], number]>((resolve) => {
          releaseClaim = resolve;
        }),
      );

      const firstTick = service.drainQueuedDigests();
      await service.drainQueuedDigests();

      expect(sends.query).toHaveBeenCalledTimes(1);
      releaseClaim(claimResult([]));
      await firstTick;

      // ...and the guard is released, so the tick after it claims again.
      await service.drainQueuedDigests();
      expect(sends.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('queueDigest', () => {
    it('writes one ledger row per confirmed subscriber', async () => {
      subscriptions.find.mockResolvedValue([{ id: 'sub-1' }, { id: 'sub-2' }]);

      await service.queueDigest({
        issueId: 'issue-1',
        issueNumber: '12',
        issueTitle: 'Winter',
        items: batch.items,
      });

      expect(batches.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: 'issue-1' }),
        ['issueId'],
      );
      expect(insertQueryBuilder.values).toHaveBeenCalledWith([
        { batchId: 'batch-1', subscriptionId: 'sub-1' },
        { batchId: 'batch-1', subscriptionId: 'sub-2' },
      ]);
      // Re-queueing a mailing must never double-send: the unique index does
      // the work, `orIgnore` is what lets it.
      expect(insertQueryBuilder.orIgnore).toHaveBeenCalled();
    });

    it('writes nothing when nobody is confirmed', async () => {
      subscriptions.find.mockResolvedValue([]);

      await service.queueDigest({
        issueId: 'issue-1',
        issueNumber: '12',
        issueTitle: 'Winter',
        items: batch.items,
      });

      expect(sends.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
