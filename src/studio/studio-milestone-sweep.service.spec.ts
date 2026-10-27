import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MIGRATION_LOCK_KEY } from '../database/migration-lock';
import {
  MATCHING_LOCK_KEY,
  RETENTION_LOCK_KEY,
} from '../go-together/go-together-matching.service';
import { IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY } from '../identities/identity-mailbox-reconciliation.service';
import { FEED_SYNC_LOCK_KEY } from '../subprofiles/feeds/subprofile-feed-sync.service';
import {
  FIRST_PLACEMENT_SWEEP_SQL,
  MILESTONE_SWEEP_LOCK_KEY,
  StudioMilestoneSweepService,
} from './studio-milestone-sweep.service';
import { SCHEDULED_RELEASES_LOCK_KEY } from './studio-scheduled-releases.service';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

describe('StudioMilestoneSweepService', () => {
  let query: jest.Mock;
  let lockRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let service: StudioMilestoneSweepService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([{ written_count: 2 }]);
    lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [],
        ),
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
    service = new StudioMilestoneSweepService({
      query,
      createQueryRunner: () => lockRunner,
    } as unknown as DataSource);
  });

  it('uses its own advisory lock key, distinct from every other sweep', () => {
    expect(MILESTONE_SWEEP_LOCK_KEY).toBe(793_640_006_000);
    expect([
      SCHEDULED_RELEASES_LOCK_KEY,
      FEED_SYNC_LOCK_KEY,
      MATCHING_LOCK_KEY,
      RETENTION_LOCK_KEY,
      IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY,
      MIGRATION_LOCK_KEY,
    ]).not.toContain(MILESTONE_SWEEP_LOCK_KEY);
  });

  it('runs one sweep under the lock and frees it on the same connection', async () => {
    await service.sweepFirstPlacements();

    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [MILESTONE_SWEEP_LOCK_KEY],
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [MILESTONE_SWEEP_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('skips the tick when another process holds the lock', async () => {
    lockRunner.query.mockResolvedValueOnce([{ locked: false }]);

    await service.sweepFirstPlacements();

    expect(query).not.toHaveBeenCalled();
    expect(lockRunner.query).not.toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      expect.anything(),
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('logs a failed sweep, frees the lock and throws nothing back at the scheduler', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.sweepFirstPlacements()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    );
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [MILESTONE_SWEEP_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs a failure to connect and still releases the connection', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    lockRunner.connect.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(service.sweepFirstPlacements()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pool exhausted'),
    );
    expect(query).not.toHaveBeenCalled();
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('marks first placements for the artist kinds with threshold 1', async () => {
    const writtenCount = await service.markFirstPlacements();

    expect(query).toHaveBeenCalledWith(FIRST_PLACEMENT_SWEEP_SQL, [
      [...STUDIO_ARTIST_PERSONA_KINDS],
      1,
    ]);
    expect(writtenCount).toBe(2);
  });

  it('reads an empty result as zero rows written', async () => {
    query.mockResolvedValueOnce([]);

    expect(await service.markFirstPlacements()).toBe(0);
  });

  it('leaves out playlists any persona member owns', () => {
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain('"subprofile_members"');
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      '"playlist"."user_id" NOT IN (',
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('reads publicly listed playlists only and returns the written count', () => {
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      `"playlist"."visibility" = 'public'`,
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain('"studio_access_grants"');
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      '"persona"."kind"::text = ANY($1::text[])',
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toMatch(/^WITH "written" AS \(/);
    expect(FIRST_PLACEMENT_SWEEP_SQL).toMatch(
      /SELECT COUNT\(\*\)::int AS "written_count" FROM "written"$/,
    );
  });

  it('counts only a listenable track on a published release', () => {
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      `"release"."status" = 'published'`,
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      '"track"."withheld_at" IS NULL',
    );
  });

  it('dates the milestone at the earliest qualifying playlist entry', () => {
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      '("subprofile_id", "kind", "threshold", "reached_at")',
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      `SELECT "persona"."id", 'first_placement', $2::int, "placement"."first_added_at"`,
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      'CROSS JOIN LATERAL (\n   SELECT MIN("entry"."added_at") AS "first_added_at"',
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      '"placement"."first_added_at" IS NOT NULL',
    );
  });

  it('keeps the NOT EXISTS guard so a reached milestone is never rewritten', () => {
    expect(FIRST_PLACEMENT_SWEEP_SQL).toMatch(
      /AND NOT EXISTS \(\s+SELECT 1 FROM "studio_artist_milestones" "reached"/,
    );
    expect(FIRST_PLACEMENT_SWEEP_SQL).toContain(
      `"reached"."kind" = 'first_placement'`,
    );
  });
});
