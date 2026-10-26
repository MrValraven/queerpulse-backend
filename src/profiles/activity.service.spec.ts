import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull, Not } from 'typeorm';
import { ActivityService } from './activity.service';
import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';

interface Harness {
  service: ActivityService;
  activities: {
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
}

async function buildService(): Promise<Harness> {
  // The trim step's query builder is chainable; every link returns the chain
  // and `execute` resolves.
  const trimChain = {
    delete: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    execute: jest.fn().mockResolvedValue({}),
  };
  trimChain.delete.mockReturnValue(trimChain);
  trimChain.from.mockReturnValue(trimChain);
  trimChain.where.mockReturnValue(trimChain);
  trimChain.andWhere.mockReturnValue(trimChain);
  const activities = {
    create: jest.fn((fields: Partial<Activity>) => fields),
    save: jest.fn((fields: Partial<Activity>) =>
      Promise.resolve({ ...fields, id: 'new-row' }),
    ),
    delete: jest.fn().mockResolvedValue({}),
    createQueryBuilder: jest.fn(() => trimChain),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ActivityService,
      { provide: getRepositoryToken(Activity), useValue: activities },
    ],
  }).compile();
  return { service: module.get(ActivityService), activities };
}

describe('ActivityService.record', () => {
  it.each([
    [ActivityKind.Persona, ActivitySubjectKind.Persona, 'persona-1'],
    [ActivityKind.Event, ActivitySubjectKind.Event, 'poetry-night'],
    [ActivityKind.Community, ActivitySubjectKind.Community, 'trans-joy'],
  ])(
    'replaces earlier %s rows about the same subject',
    async (kind, subjectKind, subjectId) => {
      const { service, activities } = await buildService();
      await service.record({
        userId: 'member-1',
        kind,
        title: 'title',
        subjectKind,
        subjectId,
      });

      expect(activities.save).toHaveBeenCalledTimes(1);
      // The new row is spared by id, so a re-publish or re-RSVP moves the row
      // to the top instead of stacking a copy.
      expect(activities.delete).toHaveBeenCalledWith({
        id: Not('new-row'),
        userId: 'member-1',
        kind,
        subjectKind,
        subjectId,
      });
    },
  );

  it('matches a missing subject kind with IS NULL', async () => {
    const { service, activities } = await buildService();
    await service.record({
      userId: 'member-1',
      kind: ActivityKind.Event,
      title: 'title',
      subjectId: 'poetry-night',
    });

    expect(activities.delete).toHaveBeenCalledWith(
      expect.objectContaining({ subjectKind: IsNull() }),
    );
  });

  it('never replaces posts, each post is its own fact', async () => {
    const { service, activities } = await buildService();
    await service.record({
      userId: 'member-1',
      kind: ActivityKind.Post,
      title: 'Posted in Trans Joy',
      subjectKind: ActivitySubjectKind.Community,
      subjectId: 'trans-joy',
    });

    expect(activities.save).toHaveBeenCalledTimes(1);
    expect(activities.delete).not.toHaveBeenCalled();
  });

  it('replaces nothing for a row with no subject id', async () => {
    const { service, activities } = await buildService();
    await service.record({
      userId: 'member-1',
      kind: ActivityKind.Persona,
      title: 'title',
    });

    expect(activities.delete).not.toHaveBeenCalled();
  });

  it('leaves earlier rows alone when the insert fails, and never throws', async () => {
    const { service, activities } = await buildService();
    activities.save.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      service.record({
        userId: 'member-1',
        kind: ActivityKind.Persona,
        title: 'title',
        subjectKind: ActivitySubjectKind.Persona,
        subjectId: 'persona-1',
      }),
    ).resolves.toBeUndefined();
    expect(activities.delete).not.toHaveBeenCalled();
  });

  it('swallows a failed replace so the member action still succeeds', async () => {
    const { service, activities } = await buildService();
    activities.delete.mockRejectedValueOnce(new Error('lock timeout'));

    await expect(
      service.record({
        userId: 'member-1',
        kind: ActivityKind.Event,
        title: 'title',
        subjectKind: ActivitySubjectKind.Event,
        subjectId: 'poetry-night',
      }),
    ).resolves.toBeUndefined();
  });
});
