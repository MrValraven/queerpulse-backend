import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { StudioReleaseReminder } from './entities/studio-release-reminder.entity';
import { StudioRelease } from './entities/studio-release.entity';
import {
  INSERT_REMINDER_SQL,
  StudioReleaseRemindersService,
} from './studio-release-reminders.service';

const VIEWER_ID = 'ce000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'ce000000-0000-4000-8000-000000000002';

function queryBuilderMock(isVisible: boolean) {
  const queryBuilder = {
    innerJoin: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getExists: jest.fn().mockResolvedValue(isVisible),
  };
  queryBuilder.innerJoin.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  return queryBuilder;
}

describe('StudioReleaseRemindersService', () => {
  let releases: { createQueryBuilder: jest.Mock };
  let reminders: { query: jest.Mock; delete: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let service: StudioReleaseRemindersService;

  beforeEach(() => {
    releases = { createQueryBuilder: jest.fn(() => queryBuilderMock(true)) };
    reminders = {
      query: jest.fn().mockResolvedValue([{ is_set: true }]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    blockFilter = { excludeBlocked: jest.fn() };
    service = new StudioReleaseRemindersService(
      releases as unknown as Repository<StudioRelease>,
      reminders as unknown as Repository<StudioReleaseReminder>,
      blockFilter as unknown as BlockFilterService,
    );
  });

  it('sets a reminder on a visible scheduled release, once however often asked', async () => {
    await service.setReminder(VIEWER_ID, RELEASE_ID);
    expect(reminders.query).toHaveBeenCalledWith(INSERT_REMINDER_SQL, [
      RELEASE_ID,
      VIEWER_ID,
    ]);
    expect(INSERT_REMINDER_SQL).toContain('ON CONFLICT DO NOTHING');
  });

  it('checks scheduled status, the listenable persona and blocks', async () => {
    const queryBuilder = queryBuilderMock(true);
    releases.createQueryBuilder.mockReturnValue(queryBuilder);
    await service.setReminder(VIEWER_ID, RELEASE_ID);
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'release.status = :scheduledStatus',
      { scheduledStatus: 'scheduled' },
    );
    const predicates = queryBuilder.andWhere.mock.calls.map(
      ([predicate]: [string]) => predicate,
    );
    expect(
      predicates.some((predicate) => predicate.includes('content_moderation')),
    ).toBe(true);
    expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
      queryBuilder,
      VIEWER_ID,
      '"persona"."user_id"',
    );
  });

  it('answers 404 for a release that is not a visible scheduled one', async () => {
    releases.createQueryBuilder.mockReturnValue(queryBuilderMock(false));
    await expect(
      service.setReminder(VIEWER_ID, RELEASE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reminders.query).not.toHaveBeenCalled();
  });

  it('answers 404 when the release stopped being scheduled before the insert ran', async () => {
    reminders.query.mockResolvedValue([{ is_set: false }]);
    await expect(
      service.setReminder(VIEWER_ID, RELEASE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 when the statement returns no row', async () => {
    reminders.query.mockResolvedValue([]);
    await expect(
      service.setReminder(VIEWER_ID, RELEASE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('inserts only while the release is scheduled, in one statement', () => {
    expect(INSERT_REMINDER_SQL).toMatch(
      /"scheduled_release" AS MATERIALIZED \(\s*SELECT "id" FROM "studio_releases" WHERE "id" = \$1::uuid AND "status" = 'scheduled' FOR SHARE\s*\)/,
    );
    expect(INSERT_REMINDER_SQL).toContain(
      'SELECT "id", $2::uuid FROM "scheduled_release"',
    );
  });

  it('counts a press that hits the unique conflict as set, so a fast second press succeeds', () => {
    // The answer reads the locked release only: an insert that conflicts
    // with a row a first press just committed still answers true, whatever
    // the second statement's snapshot holds.
    expect(INSERT_REMINDER_SQL).toContain(
      'SELECT EXISTS (SELECT 1 FROM "scheduled_release") AS "is_set"',
    );
    expect(INSERT_REMINDER_SQL).not.toContain(
      'FROM "studio_release_reminders" WHERE',
    );
  });

  it('clears a reminder whatever the release state', async () => {
    await service.clearReminder(VIEWER_ID, RELEASE_ID);
    expect(reminders.delete).toHaveBeenCalledWith({
      releaseId: RELEASE_ID,
      userId: VIEWER_ID,
    });
    expect(releases.createQueryBuilder).not.toHaveBeenCalled();
  });
});
