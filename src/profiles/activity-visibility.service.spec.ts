import { Test, TestingModule } from '@nestjs/testing';
import { FindOperator } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { Event as GatheringEvent } from '../events/entities/event.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { ActivityVisibilityService } from './activity-visibility.service';
import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';

type FindMock = { find: jest.Mock };
type ActivityRepoMock = FindMock & { delete: jest.Mock };

interface Repos {
  activities: ActivityRepoMock;
  communities: FindMock;
  events: FindMock;
  subprofiles: FindMock;
}

async function buildService(): Promise<{
  service: ActivityVisibilityService;
  repos: Repos;
}> {
  const repos: Repos = {
    activities: { find: jest.fn(), delete: jest.fn().mockResolvedValue({}) },
    communities: { find: jest.fn().mockResolvedValue([]) },
    events: { find: jest.fn().mockResolvedValue([]) },
    subprofiles: { find: jest.fn().mockResolvedValue([]) },
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ActivityVisibilityService,
      { provide: getRepositoryToken(Activity), useValue: repos.activities },
      { provide: getRepositoryToken(Community), useValue: repos.communities },
      { provide: getRepositoryToken(GatheringEvent), useValue: repos.events },
      { provide: getRepositoryToken(Subprofile), useValue: repos.subprofiles },
    ],
  }).compile();
  return { service: module.get(ActivityVisibilityService), repos };
}

function row(overrides: Partial<Activity> & { id: string }): Activity {
  return {
    // Every column the gate reads, so a row is a real `Activity` and a new
    // column added to the entity fails this spec rather than passing silently.
    userId: 'member-1',
    kind: ActivityKind.Event,
    title: 'a row',
    sub: null,
    toLink: null,
    subjectKind: null,
    subjectId: null,
    occurredAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Let the fire-and-forget purge settle before asserting on it. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ActivityVisibilityService.filterVisible', () => {
  it('drops an event row once the gathering has stopped being public', async () => {
    const { service, repos } = await buildService();
    // The lookup already filters on public + published, so a gathering that
    // turned members-only is simply absent from the result.
    repos.events.find.mockResolvedValue([]);
    const rsvpRow = row({
      id: 'row-1',
      subjectKind: ActivitySubjectKind.Event,
      subjectId: 'secret-gathering',
      toLink: '/gatherings/secret-gathering',
    });

    const visible = await service.filterVisible([rsvpRow]);

    // The whole row goes, never just its link: "RSVP'd to X" is itself the
    // disclosure.
    expect(visible).toEqual([]);
  });

  it('keeps an event row while the gathering is still public', async () => {
    const { service, repos } = await buildService();
    repos.events.find.mockResolvedValue([{ slug: 'open-gathering' }]);
    const rsvpRow = row({
      id: 'row-1',
      subjectKind: ActivitySubjectKind.Event,
      subjectId: 'open-gathering',
    });

    await expect(service.filterVisible([rsvpRow])).resolves.toEqual([rsvpRow]);
  });

  it('drops community rows once the community stops being public', async () => {
    const { service, repos } = await buildService();
    repos.communities.find.mockResolvedValue([]);
    const postRow = row({
      id: 'row-1',
      kind: ActivityKind.Post,
      subjectKind: ActivitySubjectKind.Community,
      subjectId: 'went-private',
    });
    const joinRow = row({
      id: 'row-2',
      kind: ActivityKind.Community,
      subjectKind: ActivitySubjectKind.Community,
      subjectId: 'went-private',
    });

    // Both the post and the join go: a community turning private takes every
    // row that names it.
    await expect(service.filterVisible([postRow, joinRow])).resolves.toEqual(
      [],
    );
  });

  it('drops a persona row once the persona is no longer published and open', async () => {
    const { service, repos } = await buildService();
    repos.subprofiles.find.mockResolvedValue([]);
    const personaRow = row({
      id: 'row-1',
      kind: ActivityKind.Persona,
      subjectKind: ActivitySubjectKind.Persona,
      subjectId: 'persona-id',
    });

    await expect(service.filterVisible([personaRow])).resolves.toEqual([]);
  });

  it('passes rows with no subject reference through untouched', async () => {
    const { service } = await buildService();
    // A forum thread (no visibility dimension) and a legacy row written before
    // the subject columns existed. Neither is verifiable, and neither is
    // suspect: the write gate already passed them.
    const forumRow = row({
      id: 'row-1',
      kind: ActivityKind.Post,
      toLink: '/thread/some-thread',
    });
    const legacyRow = row({ id: 'row-2' });

    await expect(service.filterVisible([forumRow, legacyRow])).resolves.toEqual(
      [forumRow, legacyRow],
    );
  });

  it('preserves the order of the rows it keeps', async () => {
    const { service, repos } = await buildService();
    repos.events.find.mockResolvedValue([{ slug: 'still-public' }]);
    const first = row({ id: 'row-1' });
    const dropped = row({
      id: 'row-2',
      subjectKind: ActivitySubjectKind.Event,
      subjectId: 'gone-private',
    });
    const third = row({
      id: 'row-3',
      subjectKind: ActivitySubjectKind.Event,
      subjectId: 'still-public',
    });

    await expect(
      service.filterVisible([first, dropped, third]),
    ).resolves.toEqual([first, third]);
  });

  it('purges the rows it drops so the anonymous endpoint cannot serve them', async () => {
    const { service, repos } = await buildService();
    repos.events.find.mockResolvedValue([]);
    const staleRow = row({
      id: 'row-1',
      subjectKind: ActivitySubjectKind.Event,
      subjectId: 'gone-private',
    });

    await service.filterVisible([staleRow]);
    await flush();

    // `PublicProfilesService` reads the same table with no gate of its own, so
    // filtering here without deleting would leave the row reachable by the
    // open web.
    expect(repos.activities.delete).toHaveBeenCalledTimes(1);
    const deleteCalls = repos.activities.delete.mock.calls as unknown as Array<
      [{ id: FindOperator<string> }]
    >;
    const firstCall = deleteCalls[0];
    if (!firstCall) {
      throw new Error('expected a purge, none was issued');
    }
    const criteria = firstCall[0];
    expect(criteria.id.value).toEqual(['row-1']);
  });

  it('never purges a row it kept', async () => {
    const { service, repos } = await buildService();
    repos.communities.find.mockResolvedValue([{ slug: 'still-public' }]);

    await service.filterVisible([
      row({
        id: 'row-1',
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'still-public',
      }),
      row({ id: 'row-2' }),
    ]);
    await flush();

    expect(repos.activities.delete).not.toHaveBeenCalled();
  });

  it('a failed purge never fails the read', async () => {
    const { service, repos } = await buildService();
    repos.events.find.mockResolvedValue([]);
    repos.activities.delete.mockRejectedValue(new Error('database is down'));

    const visible = await service.filterVisible([
      row({
        id: 'row-1',
        subjectKind: ActivitySubjectKind.Event,
        subjectId: 'gone-private',
      }),
    ]);
    await flush();

    expect(visible).toEqual([]);
  });

  it('runs no subject lookups at all when nothing needs verifying', async () => {
    const { service, repos } = await buildService();

    await service.filterVisible([row({ id: 'row-1' })]);

    expect(repos.events.find).not.toHaveBeenCalled();
    expect(repos.communities.find).not.toHaveBeenCalled();
    expect(repos.subprofiles.find).not.toHaveBeenCalled();
  });

  it('batches one lookup per kind rather than one per row', async () => {
    const { service, repos } = await buildService();
    repos.communities.find.mockResolvedValue([]);

    await service.filterVisible([
      row({
        id: 'row-1',
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'one',
      }),
      row({
        id: 'row-2',
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'two',
      }),
      row({
        id: 'row-3',
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'one',
      }),
    ]);

    expect(repos.communities.find).toHaveBeenCalledTimes(1);
  });
});
