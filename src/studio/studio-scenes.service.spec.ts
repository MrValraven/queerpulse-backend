import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioSceneState } from './entities/studio-scene.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { openUpcomingEventSql } from './studio-discovery-sql';
import {
  SCENE_ARTISTS_SQL,
  SCENE_UPCOMING_EVENTS_SQL,
  StudioScenesService,
} from './studio-scenes.service';

const VIEWER_ID = 'f6000000-0000-4000-8000-000000000001';
const SCENE_ID = 'f6000000-0000-4000-8000-000000000002';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const sceneRow = {
  id: SCENE_ID,
  slug: 'lisbon-ballroom',
  name: 'Lisbon ballroom',
  city: 'Lisbon',
  blurb: 'Vogue nights by the river.',
  coverKey: null,
  status: StudioSceneState.Active,
  position: 1,
};

describe('StudioScenesService', () => {
  let query: jest.Mock;
  let scenes: { find: jest.Mock; findOne: jest.Mock };
  let catalog: { listReleases: jest.Mock };
  let service: StudioScenesService;

  beforeEach(() => {
    query = jest.fn((sql: string) =>
      Promise.resolve(
        sql === SCENE_ARTISTS_SQL
          ? [
              {
                artist_id: 'f6000000-0000-4000-8000-000000000011',
                artist_handle: 'night-shift',
                artist_display_name: 'Night Shift',
                artist_kind: 'dj',
                artist_avatar_url: null,
                newest_published_at: new Date('2026-10-12T09:00:00.000Z'),
              },
            ]
          : [
              {
                slug: 'ballroom-night',
                title: 'Ballroom night',
                start_at: new Date('2026-10-20T21:00:00.000Z'),
                end_at: null,
                timezone: 'Europe/Lisbon',
                venue: 'Galeria',
                neighbourhood: 'Intendente',
                is_online: false,
                cover_image_url: null,
              },
            ],
      ),
    );
    scenes = {
      find: jest.fn().mockResolvedValue([sceneRow]),
      findOne: jest.fn().mockResolvedValue(sceneRow),
    };
    catalog = {
      listReleases: jest.fn().mockResolvedValue({
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    };
    service = new StudioScenesService(
      {
        query,
        getRepository: jest.fn(() => scenes),
      } as unknown as DataSource,
      catalog as unknown as StudioCatalogService,
    );
  });

  it('lists active scenes in position order as cards', async () => {
    const result = await service.listScenes();
    expect(scenes.find).toHaveBeenCalledWith({
      where: { status: StudioSceneState.Active },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    expect(result).toEqual({
      items: [
        {
          id: SCENE_ID,
          slug: 'lisbon-ballroom',
          name: 'Lisbon ballroom',
          city: 'Lisbon',
          coverUrl: null,
        },
      ],
    });
  });

  it('reads one active scene with its artists and upcoming events', async () => {
    const scene = await service.getScene(VIEWER_ID, 'Lisbon-Ballroom');

    expect(scenes.findOne).toHaveBeenCalledWith({
      where: { slug: 'lisbon-ballroom', status: StudioSceneState.Active },
    });
    expect(query).toHaveBeenCalledWith(SCENE_ARTISTS_SQL, [
      VIEWER_ID,
      SCENE_ID,
      24,
    ]);
    expect(query).toHaveBeenCalledWith(SCENE_UPCOMING_EVENTS_SQL, [
      VIEWER_ID,
      SCENE_ID,
      6,
    ]);
    expect(scene).toEqual({
      id: SCENE_ID,
      slug: 'lisbon-ballroom',
      name: 'Lisbon ballroom',
      city: 'Lisbon',
      coverUrl: null,
      blurb: 'Vogue nights by the river.',
      artists: [
        {
          id: 'f6000000-0000-4000-8000-000000000011',
          handle: 'night-shift',
          name: 'Night Shift',
          kind: 'dj',
          avatarUrl: null,
        },
      ],
      upcomingEvents: [
        {
          slug: 'ballroom-night',
          title: 'Ballroom night',
          startAt: '2026-10-20T21:00:00.000Z',
          endAt: null,
          timezone: 'Europe/Lisbon',
          venue: 'Galeria',
          neighbourhood: 'Intendente',
          isOnline: false,
          coverImageUrl: null,
        },
      ],
    });
  });

  it('answers 404 for an archived scene and for its releases', async () => {
    scenes.findOne.mockResolvedValue(null);
    expect(await codeOf(service.getScene(VIEWER_ID, 'lisbon-ballroom'))).toBe(
      'studio_scene_not_found',
    );
    expect(
      await codeOf(
        service.listSceneReleases(VIEWER_ID, 'lisbon-ballroom', undefined),
      ),
    ).toBe('studio_scene_not_found');
    expect(catalog.listReleases).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('pages the scene releases through the listenable feed, narrowed to the scene', async () => {
    await service.listSceneReleases(VIEWER_ID, 'lisbon-ballroom', 'abc');
    expect(catalog.listReleases).toHaveBeenCalledWith(VIEWER_ID, 'abc', {
      sceneId: SCENE_ID,
    });
  });

  it('reads scene artists among listenable releases of the scene, newest first', () => {
    expect(SCENE_ARTISTS_SQL).toContain('"release"."scene_id" = $2');
    expect(SCENE_ARTISTS_SQL).toContain(`"release"."status" = 'published'`);
    expect(SCENE_ARTISTS_SQL).toContain('FROM "blocks" "persona_block"');
    expect(SCENE_ARTISTS_SQL).toContain(
      'ORDER BY "newest_published_at" DESC, "persona"."id" ASC',
    );
  });

  it('unions pinned events with the public event affiliations of the scene artists, upcoming and open to browse only', () => {
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      'FROM "studio_scene_events" "pin"',
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain('UNION');
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      `"affiliation"."target_type" = 'event'`,
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      '"affiliated_event"."slug" = "affiliation"."target_slug"',
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      `"event"."status" = 'published'`,
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain('"event"."start_at" > now()');
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      `"event"."visibility" IN ('public', 'members')`,
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      `"event_moderation"."subject_type" = 'event'`,
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      'FROM "blocks" "event_host_block"',
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(
      'ORDER BY "event"."start_at" ASC, "event"."id" ASC',
    );
    expect(SCENE_UPCOMING_EVENTS_SQL).toContain(openUpcomingEventSql('event'));
  });
});
