import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import {
  SCHEDULED_RELEASES_LOCK_KEY,
  SCHEDULED_RELEASE_CLAIM_SQL,
  StudioScheduledReleasesService,
} from './studio-scheduled-releases.service';
import { STUDIO_RELEASE_PUBLISHED } from './studio.events';

const FIRST_RELEASE = 'ca000000-0000-4000-8000-000000000001';
const SECOND_RELEASE = 'ca000000-0000-4000-8000-000000000002';

describe('StudioScheduledReleasesService', () => {
  let query: jest.Mock;
  let lockRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let emit: jest.Mock;
  let service: StudioScheduledReleasesService;

  beforeEach(() => {
    query = jest
      .fn()
      .mockResolvedValue([
        { release_id: FIRST_RELEASE },
        { release_id: SECOND_RELEASE },
      ]);
    lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [],
        ),
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
    emit = jest.fn();
    service = new StudioScheduledReleasesService(
      {
        query,
        createQueryRunner: () => lockRunner,
      } as unknown as DataSource,
      { emit } as unknown as EventEmitter2,
    );
  });

  it('uses its own advisory lock key, distinct from every other sweep', () => {
    expect(SCHEDULED_RELEASES_LOCK_KEY).toBe(793_640_005_000);
  });

  it('claims at most 100 due scheduled releases, oldest time first, skipping locked rows', () => {
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(`"status" = 'scheduled'`);
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain('"publish_at" <= now()');
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      'ORDER BY "publish_at" ASC, "id" ASC',
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain('FOR UPDATE SKIP LOCKED');
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      `"published_at" = "release"."publish_at"`,
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain('"publish_at" = NULL');
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toMatch(/^WITH "due" AS \(/);
  });

  it('fills an empty release date with the Lisbon date of publish_at and keeps a typed one', () => {
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      `"released_on" = COALESCE("release"."released_on", ("release"."publish_at" AT TIME ZONE 'Europe/Lisbon')::date)`,
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toMatch(
      /SELECT "release_id" FROM "published"$/,
    );
  });

  it('publishes the due releases and tells the alert listener about each after the statement', async () => {
    const releaseIds = await service.publishDue();

    expect(query).toHaveBeenCalledWith(SCHEDULED_RELEASE_CLAIM_SQL, [100]);
    expect(releaseIds).toEqual([FIRST_RELEASE, SECOND_RELEASE]);
    expect(emit.mock.calls).toEqual([
      [STUDIO_RELEASE_PUBLISHED, { releaseId: FIRST_RELEASE }],
      [STUDIO_RELEASE_PUBLISHED, { releaseId: SECOND_RELEASE }],
    ]);
  });

  it('runs one sweep under the lock and frees it on the same connection', async () => {
    await service.publishDueReleases();

    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [SCHEDULED_RELEASES_LOCK_KEY],
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [SCHEDULED_RELEASES_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('skips the tick when another process holds the lock', async () => {
    lockRunner.query.mockResolvedValueOnce([{ locked: false }]);

    await service.publishDueReleases();

    expect(query).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('logs a failed sweep, frees the lock and throws nothing back at the scheduler', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.publishDueReleases()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    );
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [SCHEDULED_RELEASES_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs a failure to connect or take the lock and still releases the connection', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    lockRunner.connect.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(service.publishDueReleases()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pool exhausted'),
    );

    lockRunner.query.mockRejectedValueOnce(new Error('lock query failed'));
    await expect(service.publishDueReleases()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('lock query failed'),
    );

    expect(query).not.toHaveBeenCalled();
    expect(lockRunner.query).not.toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      expect.anything(),
    );
    expect(lockRunner.release).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  // Studio artist kinds.
  it('stamps the episodes of a dropped show with the drop time and the claim marker', () => {
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain('"stamped_episodes" AS (');
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      `"published"."release_type" = 'podcast'`,
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      '"published_at" = "published"."published_at"',
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      '"followers_notified_at" = now()',
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      '"episode"."published_at" IS NULL',
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toContain(
      '"episode"."audio_key" IS NOT NULL',
    );
    expect(SCHEDULED_RELEASE_CLAIM_SQL).toMatch(
      /SELECT "release_id" FROM "published"$/,
    );
  });
});
