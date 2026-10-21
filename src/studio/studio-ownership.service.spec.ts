import { HttpException, NotFoundException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import {
  OPEN_COUNTER_WINDOWS_SQL,
  StudioOwnershipService,
} from './studio-ownership.service';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

const USER_ID = '7d000000-0000-4000-8000-000000000001';
const PERSONA_ID = '7d000000-0000-4000-8000-000000000002';
const RELEASE_ID = '7d000000-0000-4000-8000-000000000003';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const releaseWith = (status: StudioReleaseStatus) =>
  ({ id: RELEASE_ID, subprofileId: PERSONA_ID, status }) as StudioRelease;

describe('StudioOwnershipService', () => {
  let members: { exists: jest.Mock };
  let subprofiles: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let releases: { findOne: jest.Mock; query: jest.Mock };
  let manager: { findOne: jest.Mock; exists: jest.Mock };
  let service: StudioOwnershipService;

  beforeEach(() => {
    members = { exists: jest.fn().mockResolvedValue(true) };
    subprofiles = {
      findOne: jest.fn().mockResolvedValue({ id: PERSONA_ID, kind: 'dj' }),
      createQueryBuilder: jest.fn(),
    };
    releases = {
      findOne: jest
        .fn()
        .mockResolvedValue(releaseWith(StudioReleaseStatus.Draft)),
      query: jest.fn().mockResolvedValue([{ count: 2 }]),
    };
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === StudioRelease
            ? releaseWith(StudioReleaseStatus.Draft)
            : { id: PERSONA_ID, kind: 'musician' },
        ),
      ),
      exists: jest.fn().mockResolvedValue(true),
    };
    service = new StudioOwnershipService(
      members as unknown as Repository<SubprofileMember>,
      subprofiles as unknown as Repository<Subprofile>,
      releases as unknown as Repository<StudioRelease>,
    );
  });

  it('counts the open counter-notice windows across every persona the member runs', async () => {
    expect(await service.countOpenCounterWindows(USER_ID)).toBe(2);
    expect(releases.query).toHaveBeenCalledWith(OPEN_COUNTER_WINDOWS_SQL, [
      USER_ID,
    ]);
    expect(OPEN_COUNTER_WINDOWS_SQL).toContain(`"claim"."status" = 'accepted'`);
    expect(OPEN_COUNTER_WINDOWS_SQL).toContain(
      '"claim"."counter_note" IS NULL',
    );
    expect(OPEN_COUNTER_WINDOWS_SQL).toContain('"persona"."user_id" = $1 OR');
    expect(OPEN_COUNTER_WINDOWS_SQL).toContain('"member"."user_id" = $1');
  });

  it('reads no rows as no open windows', async () => {
    releases.query.mockResolvedValueOnce([]);
    expect(await service.countOpenCounterWindows(USER_ID)).toBe(0);
  });

  it('counts any roster row as ownership, co-owners included', async () => {
    expect(await service.isPersonaMember(USER_ID, PERSONA_ID)).toBe(true);
    expect(members.exists).toHaveBeenCalledWith({
      where: { userId: USER_ID, subprofileId: PERSONA_ID },
    });
  });

  it('refuses a non-member and an unknown persona with the same code', async () => {
    members.exists.mockResolvedValue(false);
    expect(await codeOf(service.assertArtistPersona(USER_ID, PERSONA_ID))).toBe(
      'studio_not_persona_owner',
    );
    subprofiles.findOne.mockResolvedValue(null);
    expect(await codeOf(service.assertArtistPersona(USER_ID, PERSONA_ID))).toBe(
      'studio_not_persona_owner',
    );
  });

  it('refuses a persona of another kind', async () => {
    subprofiles.findOne.mockResolvedValue({ id: PERSONA_ID, kind: 'poet' });
    expect(await codeOf(service.assertArtistPersona(USER_ID, PERSONA_ID))).toBe(
      'studio_persona_kind_not_allowed',
    );
  });

  it('locks the release row inside the caller transaction', async () => {
    const context = await service.lockReleaseForWrite(
      manager as unknown as EntityManager,
      USER_ID,
      RELEASE_ID,
    );
    expect(manager.findOne).toHaveBeenCalledWith(StudioRelease, {
      where: { id: RELEASE_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.exists).toHaveBeenCalledWith(SubprofileMember, {
      where: { userId: USER_ID, subprofileId: PERSONA_ID },
    });
    expect(context.persona.kind).toBe('musician');
  });

  it('refuses a write once the persona is no longer a Studio artist kind', async () => {
    manager.findOne.mockImplementation((entity: unknown) =>
      Promise.resolve(
        entity === StudioRelease
          ? releaseWith(StudioReleaseStatus.Published)
          : { id: PERSONA_ID, kind: 'writer' },
      ),
    );
    expect(
      await codeOf(
        service.lockReleaseForWrite(
          manager as unknown as EntityManager,
          USER_ID,
          RELEASE_ID,
        ),
      ),
    ).toBe('studio_persona_kind_not_allowed');
  });

  it('answers a non-owner 404 for a draft and 403 for a published release', async () => {
    members.exists.mockResolvedValue(false);
    await expect(
      service.loadReleaseForWrite(USER_ID, RELEASE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    releases.findOne.mockResolvedValue(
      releaseWith(StudioReleaseStatus.Published),
    );
    expect(await codeOf(service.loadReleaseForWrite(USER_ID, RELEASE_ID))).toBe(
      'studio_not_persona_owner',
    );
  });

  it('answers a non-owner 403 for a scheduled release, which granted members can see', async () => {
    members.exists.mockResolvedValue(false);
    releases.findOne.mockResolvedValue(
      releaseWith(StudioReleaseStatus.Scheduled),
    );
    expect(await codeOf(service.loadReleaseForWrite(USER_ID, RELEASE_ID))).toBe(
      'studio_not_persona_owner',
    );
  });

  it('answers 404 for a release that does not exist', async () => {
    releases.findOne.mockResolvedValue(null);
    await expect(
      service.loadReleaseForWrite(USER_ID, RELEASE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists uploadable personas through the listenable predicate and the artist kinds', async () => {
    const queryBuilder = {} as Record<
      'select' | 'innerJoin' | 'where' | 'andWhere' | 'orderBy' | 'getMany',
      jest.Mock
    >;
    for (const method of [
      'select',
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
    ] as const) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue([]);
    subprofiles.createQueryBuilder.mockReturnValue(queryBuilder);

    await service.listUploadablePersonas(USER_ID);

    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      SubprofileMember,
      'member',
      '"member"."subprofile_id" = "persona"."id" AND "member"."user_id" = :uploaderId',
      { uploaderId: USER_ID },
    );
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'persona.kind IN (:...artistKinds)',
      { artistKinds: [...STUDIO_ARTIST_PERSONA_KINDS] },
    );
    const predicates = queryBuilder.andWhere.mock.calls.map(
      ([predicate]) => predicate as string,
    );
    expect(
      predicates.some((predicate) => predicate.includes('content_moderation')),
    ).toBe(true);
  });

  // Studio artist kinds: the new kinds create releases like musicians do.
  it.each(['podcaster', 'poet', 'drag'])(
    'lets a %s persona the member runs create a release',
    async (kind) => {
      subprofiles.findOne.mockResolvedValue({ id: PERSONA_ID, kind });
      members.exists.mockResolvedValue(true);
      await expect(
        service.assertArtistPersona(USER_ID, PERSONA_ID),
      ).resolves.toEqual({ id: PERSONA_ID, kind });
    },
  );
});
