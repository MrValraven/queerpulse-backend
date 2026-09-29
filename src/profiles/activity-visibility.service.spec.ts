import { Test, TestingModule } from '@nestjs/testing';
import { FindOperator, IsNull } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { Connection } from '../connections/entities/connection.entity';
import { Event as GatheringEvent } from '../events/entities/event.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import { ActivityVisibilityService } from './activity-visibility.service';
import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';

type FindMock = { find: jest.Mock };
type ForumThreadQueryBuilderMock = {
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  getRawMany: jest.Mock;
};
type ActivityRepoMock = FindMock & {
  delete: jest.Mock;
  manager: { createQueryBuilder: jest.Mock; getRepository: jest.Mock };
  forumThreadQueryBuilder: ForumThreadQueryBuilderMock;
  eventRsvps: FindMock;
  connections: FindMock;
};

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
  const forumThreadQueryBuilder: ForumThreadQueryBuilderMock = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  // The Event arm's PRD-414 RSVP-visibility gate reads `EventRsvp` and
  // `Connection` off `this.activities.manager.getRepository(...)`, the same
  // pattern the forum-thread check above uses to read `ForumThread` off
  // `manager.createQueryBuilder` with no injected repository token of its
  // own. Both are stubbed here and dispatched on the entity class the
  // service asks for.
  const eventRsvps: FindMock = { find: jest.fn().mockResolvedValue([]) };
  const connections: FindMock = { find: jest.fn().mockResolvedValue([]) };
  const getRepository = jest.fn((entity: unknown) => {
    if (entity === EventRsvp) {
      return eventRsvps;
    }
    if (entity === Connection) {
      return connections;
    }
    throw new Error(
      'ActivityVisibilityService asked for an unstubbed repository',
    );
  });
  const repos: Repos = {
    activities: {
      find: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      manager: {
        createQueryBuilder: jest.fn().mockReturnValue(forumThreadQueryBuilder),
        getRepository,
      },
      forumThreadQueryBuilder,
      eventRsvps,
      connections,
    },
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
    // column added to the entity fails this spec loudly.
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

    // The whole row goes along with its link: "RSVP'd to X" is itself the
    // disclosure.
    expect(visible).toEqual([]);
  });

  it('keeps an event row while the gathering is still public', async () => {
    const { service, repos } = await buildService();
    repos.events.find.mockResolvedValue([
      { id: 'event-1', slug: 'open-gathering' },
    ]);
    // The RSVP behind the row is still there (the Event arm's second gate).
    repos.activities.eventRsvps.find.mockResolvedValue([
      { eventId: 'event-1', userId: 'member-1', visibility: null },
    ]);
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

  // The row names its author ("Published a persona: X"). After a creator
  // handoff the successor can switch X to Unlinked and republish it at its
  // handle, which leaves it published and open. The read gate matches the
  // listener's write gate and requires Linked, so the row drops and the
  // former creator stops being tied to an unattributed persona.
  it('drops a persona row once the persona is switched to Unlinked', async () => {
    const { service, repos } = await buildService();
    // The lookup already filters on Linked, so an unlinked persona that is
    // still published and open is absent from the result.
    repos.subprofiles.find.mockResolvedValue([]);
    const personaRow = row({
      id: 'row-1',
      kind: ActivityKind.Persona,
      subjectKind: ActivitySubjectKind.Persona,
      subjectId: 'persona-id',
      toLink: '/members/former-creator/persona-slug',
    });

    await expect(service.filterVisible([personaRow])).resolves.toEqual([]);
    await flush();

    const [{ where }] = repos.subprofiles.find.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(where).toMatchObject({
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    expect(where.removedAt).toEqual(IsNull());
    expect(repos.activities.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps a persona row while the persona is published, open and linked', async () => {
    const { service, repos } = await buildService();
    repos.subprofiles.find.mockResolvedValue([{ id: 'persona-id' }]);
    const personaRow = row({
      id: 'row-1',
      kind: ActivityKind.Persona,
      subjectKind: ActivitySubjectKind.Persona,
      subjectId: 'persona-id',
    });

    await expect(service.filterVisible([personaRow])).resolves.toEqual([
      personaRow,
    ]);
  });

  // N4: a persona row keeps asserting "published a persona" once a moderator
  // takes the persona down, even though its own `removedAt` stays null. The
  // gate must drop it, batched into the same query as the column filters.
  it('drops a persona row under a moderator takedown in one batched query', async () => {
    const { service, repos } = await buildService();
    // The persona still satisfies every column filter; a real query drops it
    // through the NOT EXISTS clause, so the mock returns empty to model that.
    repos.subprofiles.find.mockResolvedValue([]);
    const personaRow = row({
      id: 'row-1',
      kind: ActivityKind.Persona,
      subjectKind: ActivitySubjectKind.Persona,
      subjectId: 'persona-id',
    });

    await expect(service.filterVisible([personaRow])).resolves.toEqual([]);

    expect(repos.subprofiles.find).toHaveBeenCalledTimes(1);
    const [{ where }] = repos.subprofiles.find.mock.calls[0] as [
      { where: { id: FindOperator<string> } },
    ];
    const sql = where.id.getSql?.('Subprofile.id') ?? '';
    expect(sql).toContain('Subprofile.id IN (:...personaIds)');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('FROM "content_moderation" "cm"');
    expect(sql).toContain('"cm"."subject_id" = Subprofile.id::text');
    expect(sql).toContain(
      '"cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL',
    );
    expect(where.id.objectLiteralParameters).toEqual({
      personaIds: ['persona-id'],
      subprofileTakedownSubjectType: SUBPROFILE_MODERATION_SUBJECT_TYPE,
    });
  });

  it('passes rows with no subject reference through untouched', async () => {
    const { service } = await buildService();
    // Rows written before the subject columns existed. Neither is verifiable,
    // and neither is suspect: the write gate already passed them. A legacy
    // forum row gets its thread subject from the backfill migration, after
    // which the forum-thread re-check below applies to it.
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
    repos.events.find.mockResolvedValue([
      { id: 'event-1', slug: 'still-public' },
    ]);
    repos.activities.eventRsvps.find.mockResolvedValue([
      { eventId: 'event-1', userId: 'member-1', visibility: null },
    ]);
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

  it('scopes the community re-check to top-level communities, excluding spaces', async () => {
    const { service, repos } = await buildService();
    repos.communities.find.mockResolvedValue([]);

    await service.filterVisible([
      row({
        id: 'row-1',
        subjectKind: ActivitySubjectKind.Community,
        subjectId: 'a-space',
      }),
    ]);
    await flush();

    const [{ where }] = repos.communities.find.mock.calls[0] as [
      { where: { parentId?: unknown } },
    ];
    expect(where.parentId).toEqual(IsNull());
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

  it('filterVisible drops an anonymous, withdrawn, scheduled or private-community thread row and purges it', async () => {
    const { service, repos } = await buildService();
    // The lookup filters on every gate in SQL, so of these five threads only
    // the forum-wide one under its writer's own byline comes back.
    repos.activities.forumThreadQueryBuilder.getRawMany.mockResolvedValue([
      { slug: 'open-thread' },
    ]);
    const threadRow = (id: string, slug: string) =>
      row({
        id,
        kind: ActivityKind.Post,
        subjectKind: ActivitySubjectKind.ForumThread,
        subjectId: slug,
        toLink: `/thread/${slug}`,
      });
    const anonymousRow = threadRow('row-1', 'anonymous-thread');
    const withdrawnRow = threadRow('row-2', 'withdrawn-thread');
    const scheduledRow = threadRow('row-3', 'scheduled-thread');
    const privateCommunityRow = threadRow('row-4', 'private-community-thread');
    const openRow = threadRow('row-5', 'open-thread');

    const visible = await service.filterVisible([
      anonymousRow,
      withdrawnRow,
      scheduledRow,
      privateCommunityRow,
      openRow,
    ]);
    await flush();

    expect(visible).toEqual([openRow]);
    const builder = repos.activities.forumThreadQueryBuilder;
    expect(builder.where).toHaveBeenCalledWith('t.slug IN (:...slugs)', {
      slugs: [
        'anonymous-thread',
        'withdrawn-thread',
        'scheduled-thread',
        'private-community-thread',
        'open-thread',
      ],
    });
    const gateSql = (
      builder.andWhere.mock.calls as unknown as Array<[string]>
    ).map(([sql]) => sql);
    expect(gateSql).toEqual(
      expect.arrayContaining([
        't.deleted_at IS NULL',
        't.is_anonymous = false',
        't.is_official = false',
      ]),
    );
    expect(gateSql.join(' ')).toContain('t.published_at <= now()');
    expect(gateSql.join(' ')).toContain('t.cross_posted = true');
    expect(gateSql.join(' ')).toContain(
      '"activity_com"."access_tier" = :activityPublicTier',
    );

    const deleteCalls = repos.activities.delete.mock.calls as unknown as Array<
      [{ id: FindOperator<string> }]
    >;
    const firstCall = deleteCalls[0];
    if (!firstCall) {
      throw new Error('expected a purge, none was issued');
    }
    expect(firstCall[0].id.value).toEqual(['row-1', 'row-2', 'row-3', 'row-4']);
  });

  it('runs no subject lookups at all when nothing needs verifying', async () => {
    const { service, repos } = await buildService();

    await service.filterVisible([row({ id: 'row-1' })]);

    expect(repos.events.find).not.toHaveBeenCalled();
    expect(repos.communities.find).not.toHaveBeenCalled();
    expect(repos.subprofiles.find).not.toHaveBeenCalled();
    expect(repos.activities.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('batches one lookup per kind for any number of rows', async () => {
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

describe('ActivityVisibilityService.filterVisible: PRD-414 RSVP visibility (Event arm)', () => {
  const GATHERING_SLUG = 'the-gathering';
  const GATHERING_ID = 'event-uuid-1';

  /** A public, published gathering, returned for both the subject re-check
   *  and the slug-to-id lookup the RSVP gate runs afterwards. */
  const stubPublicGathering = (repos: Repos) => {
    repos.events.find.mockResolvedValue([
      { id: GATHERING_ID, slug: GATHERING_SLUG },
    ]);
  };

  function eventRow(overrides: Partial<Activity> & { id: string }): Activity {
    return row({
      subjectKind: ActivitySubjectKind.Event,
      subjectId: GATHERING_SLUG,
      ...overrides,
    });
  }

  it('shows a stranger everyone and null RSVPs, hides connections and justMe', async () => {
    const { service, repos } = await buildService();
    stubPublicGathering(repos);
    repos.activities.eventRsvps.find.mockResolvedValue([
      {
        eventId: GATHERING_ID,
        userId: 'attendee-everyone',
        visibility: 'everyone',
      },
      { eventId: GATHERING_ID, userId: 'attendee-null', visibility: null },
      {
        eventId: GATHERING_ID,
        userId: 'attendee-connections',
        visibility: 'connections',
      },
      {
        eventId: GATHERING_ID,
        userId: 'attendee-justme',
        visibility: 'justMe',
      },
    ]);
    repos.activities.connections.find.mockResolvedValue([]);
    const everyoneRow = eventRow({ id: 'row-1', userId: 'attendee-everyone' });
    const nullRow = eventRow({ id: 'row-2', userId: 'attendee-null' });
    const connectionsRow = eventRow({
      id: 'row-3',
      userId: 'attendee-connections',
    });
    const justMeRow = eventRow({ id: 'row-4', userId: 'attendee-justme' });

    const visible = await service.filterVisible(
      [everyoneRow, nullRow, connectionsRow, justMeRow],
      'stranger-1',
    );

    expect(visible).toEqual([everyoneRow, nullRow]);
  });

  it('shows the owner every one of their own rows, whatever the RSVP visibility says', async () => {
    const { service, repos } = await buildService();
    stubPublicGathering(repos);
    const everyoneRow = eventRow({ id: 'row-1', userId: 'the-attendee' });
    const connectionsRow = eventRow({ id: 'row-2', userId: 'the-attendee' });
    const justMeRow = eventRow({ id: 'row-3', userId: 'the-attendee' });

    const visible = await service.filterVisible(
      [everyoneRow, connectionsRow, justMeRow],
      'the-attendee',
    );

    expect(visible).toEqual([everyoneRow, connectionsRow, justMeRow]);
    // The owner shortcut drops every one of their own rows before the RSVP
    // and connection lookups run at all.
    expect(repos.activities.eventRsvps.find).not.toHaveBeenCalled();
    expect(repos.activities.connections.find).not.toHaveBeenCalled();
  });

  it("shows a connections-only row to the attendee's accepted connection", async () => {
    const { service, repos } = await buildService();
    stubPublicGathering(repos);
    repos.activities.eventRsvps.find.mockResolvedValue([
      {
        eventId: GATHERING_ID,
        userId: 'connected-attendee',
        visibility: 'connections',
      },
      {
        eventId: GATHERING_ID,
        userId: 'unconnected-attendee',
        visibility: 'connections',
      },
    ]);
    repos.activities.connections.find.mockResolvedValue([
      {
        requesterId: 'viewer-1',
        addresseeId: 'connected-attendee',
        status: 'accepted',
      },
    ]);
    const connectedRow = eventRow({
      id: 'row-1',
      userId: 'connected-attendee',
    });
    const unconnectedRow = eventRow({
      id: 'row-2',
      userId: 'unconnected-attendee',
    });

    const visible = await service.filterVisible(
      [connectedRow, unconnectedRow],
      'viewer-1',
    );

    expect(visible).toEqual([connectedRow]);
  });

  // M5: the roster lists live RSVP rows only, so an activity row with no
  // RSVP behind it shows to its owner alone, and stays in the table.
  it('shows a row with no RSVP behind it to its owner alone', async () => {
    const { service, repos } = await buildService();
    stubPublicGathering(repos);
    repos.activities.eventRsvps.find.mockResolvedValue([]);
    const orphanRow = eventRow({ id: 'row-1', userId: 'former-attendee' });

    const strangerView = await service.filterVisible([orphanRow], 'stranger-1');
    const anonymousView = await service.filterVisible([orphanRow], null);
    const ownerView = await service.filterVisible(
      [orphanRow],
      'former-attendee',
    );
    await flush();

    expect(strangerView).toEqual([]);
    expect(anonymousView).toEqual([]);
    expect(ownerView).toEqual([orphanRow]);
    expect(repos.activities.delete).not.toHaveBeenCalled();
  });

  // O3: a self-cancel or a host removal leaves the RSVP row in place with
  // `status = 'cancelled'` and never deletes it, so the roster drops the
  // attendee while the row would otherwise survive this gate untouched. A
  // cancelled RSVP is treated exactly like a missing one.
  it('shows a row behind a cancelled RSVP to its owner alone', async () => {
    const { service, repos } = await buildService();
    stubPublicGathering(repos);
    repos.activities.eventRsvps.find.mockResolvedValue([
      {
        eventId: GATHERING_ID,
        userId: 'cancelled-attendee',
        visibility: 'everyone',
        status: 'cancelled',
      },
    ]);
    const cancelledRow = eventRow({
      id: 'row-1',
      userId: 'cancelled-attendee',
    });

    const strangerView = await service.filterVisible(
      [cancelledRow],
      'stranger-1',
    );
    const ownerView = await service.filterVisible(
      [cancelledRow],
      'cancelled-attendee',
    );
    await flush();

    expect(strangerView).toEqual([]);
    expect(ownerView).toEqual([cancelledRow]);
    expect(repos.activities.delete).not.toHaveBeenCalled();
  });

  it('keeps a row the RSVP setting hides in the table', async () => {
    const { service, repos } = await buildService();
    stubPublicGathering(repos);
    repos.activities.eventRsvps.find.mockResolvedValue([
      { eventId: GATHERING_ID, userId: 'attendee-1', visibility: 'justMe' },
    ]);
    const hiddenRow = eventRow({ id: 'row-1', userId: 'attendee-1' });

    const visible = await service.filterVisible([hiddenRow], 'stranger-1');
    await flush();

    expect(visible).toEqual([]);
    expect(repos.activities.delete).not.toHaveBeenCalled();
  });
});
