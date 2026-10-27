import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SubprofileFollowedEvent } from '../subprofiles/subprofile.events';
import {
  FOLLOWER_MILESTONES_INSERT_SQL,
  FOLLOWER_TOTAL_SQL,
  StudioFollowerMilestonesListener,
} from './studio-follower-milestones.listener';

const PERSONA_ID = 'c9100000-0000-4000-8000-00000000000a';
const FOLLOWER_ID = 'c9000000-0000-4000-8000-000000000001';
const OWNER_ID = 'c9000000-0000-4000-8000-000000000002';

describe('StudioFollowerMilestonesListener', () => {
  let query: jest.Mock;
  let listener: StudioFollowerMilestonesListener;
  let warnSpy: jest.SpyInstance;
  const event: SubprofileFollowedEvent = {
    subprofileId: PERSONA_ID,
    followerId: FOLLOWER_ID,
    ownerId: OWNER_ID,
  };

  beforeEach(() => {
    query = jest.fn();
    listener = new StudioFollowerMilestonesListener({
      query,
    } as unknown as DataSource);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('writes every follower threshold at or below the new count', async () => {
    query
      .mockResolvedValueOnce([
        { subprofile_id: PERSONA_ID, kind: 'dj', follower_count: 27 },
      ])
      .mockResolvedValueOnce([]);

    await listener.recordFollowerMilestones({
      subprofileId: PERSONA_ID.toUpperCase(),
      followerId: FOLLOWER_ID,
      ownerId: OWNER_ID,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, FOLLOWER_TOTAL_SQL, [
      PERSONA_ID.toUpperCase(),
    ]);
    expect(query).toHaveBeenNthCalledWith(2, FOLLOWER_MILESTONES_INSERT_SQL, [
      PERSONA_ID,
      [10, 25],
    ]);
  });

  it('writes the thousands past the fixed list for a large count', async () => {
    query
      .mockResolvedValueOnce([
        { subprofile_id: PERSONA_ID, kind: 'musician', follower_count: '3200' },
      ])
      .mockResolvedValueOnce([]);

    await listener.recordFollowerMilestones(event);

    expect(query).toHaveBeenNthCalledWith(2, FOLLOWER_MILESTONES_INSERT_SQL, [
      PERSONA_ID,
      [10, 25, 50, 100, 250, 500, 1000, 2000, 3000],
    ]);
  });

  it('writes nothing below ten followers', async () => {
    query.mockResolvedValueOnce([
      { subprofile_id: PERSONA_ID, kind: 'dj', follower_count: 9 },
    ]);

    await listener.recordFollowerMilestones(event);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(FOLLOWER_TOTAL_SQL, [PERSONA_ID]);
  });

  it('writes nothing for a persona outside the artist kinds', async () => {
    query.mockResolvedValueOnce([
      { subprofile_id: PERSONA_ID, kind: 'developer', follower_count: 40 },
    ]);

    await listener.recordFollowerMilestones(event);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a persona that no longer exists', async () => {
    query.mockResolvedValueOnce([]);

    await listener.recordFollowerMilestones(event);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('lets a repeat insert pass through ON CONFLICT DO NOTHING', () => {
    expect(FOLLOWER_MILESTONES_INSERT_SQL).toMatch(/ON CONFLICT DO NOTHING/);
    expect(FOLLOWER_MILESTONES_INSERT_SQL).toContain(
      `SELECT $1::uuid, 'followers', unnest($2::int[])`,
    );
  });

  it('reads the persona kind as text and counts its followers', () => {
    expect(FOLLOWER_TOTAL_SQL).toContain('"persona"."kind"::text AS "kind"');
    expect(FOLLOWER_TOTAL_SQL).toContain('"subprofile_followers" "follower"');
    expect(FOLLOWER_TOTAL_SQL).toContain('WHERE "persona"."id" = $1');
  });

  it('logs a failed write and throws nothing back at the emitter', async () => {
    query.mockRejectedValue(new Error('connection lost'));

    await expect(
      listener.recordFollowerMilestones(event),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    );
  });

  it('logs a failed insert after a successful read', async () => {
    query
      .mockResolvedValueOnce([
        { subprofile_id: PERSONA_ID, kind: 'dj', follower_count: 12 },
      ])
      .mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(
      listener.recordFollowerMilestones(event),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('deadlock detected'),
    );
  });
});
