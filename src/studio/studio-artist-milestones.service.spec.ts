import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { StudioArtistMilestonesService } from './studio-artist-milestones.service';
import { StudioMilestone, StudioMilestoneRow } from './studio-milestones';
import { StudioOwnershipService } from './studio-ownership.service';

const OWNER_ID = 'b1000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'b1000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'b2000000-0000-4000-8000-000000000001';
const MILESTONE_ID = 'b3000000-0000-4000-8000-000000000001';
const NEWER_ID = 'b3000000-0000-4000-8000-000000000002';
const OLDER_ID = 'b3000000-0000-4000-8000-000000000003';
const UNKNOWN_ID = 'b3000000-0000-4000-8000-0000000000ff';

const milestoneRow = (
  id: string,
  reachedAt: string,
  threshold = 100,
): StudioMilestoneRow => ({
  id,
  subprofile_id: PERSONA_ID,
  kind: 'followers',
  threshold: String(threshold),
  reached_at: new Date(reachedAt),
  track_id: null,
  track_title: null,
});

const FOLLOWER_MILESTONE: StudioMilestone = {
  id: MILESTONE_ID,
  kind: 'followers',
  threshold: 100,
  track: null,
  reachedAt: '2026-10-20T09:00:00.000Z',
};

const personaRow = (kind: string) => ({
  id: PERSONA_ID,
  handle: 'night-shift',
  displayName: 'Night Shift',
  kind,
  avatarUrl: null,
  // A stray member column on the row must never reach the card.
  userId: OWNER_ID,
});

async function refusalBody(read: () => Promise<unknown>): Promise<unknown> {
  try {
    await read();
  } catch (error) {
    return (error as HttpException).getResponse();
  }
  throw new Error('expected the read to refuse');
}

describe('StudioArtistMilestonesService', () => {
  let query: jest.Mock;
  let andWhereCalls: string[];
  let andWhereParameters: unknown[];
  let queryBuilder: {
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getOne: jest.Mock;
  };
  let subprofiles: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let ownership: { isPersonaMember: jest.Mock };
  let service: StudioArtistMilestonesService;

  beforeEach(() => {
    query = jest.fn((sql: string, parameters: unknown[]) => {
      if (sql.includes('WHERE "milestone"."id" = $1')) {
        return Promise.resolve(
          parameters[0] === MILESTONE_ID
            ? [milestoneRow(MILESTONE_ID, '2026-10-20T09:00:00.000Z')]
            : [],
        );
      }
      if (sql.includes('WHERE "milestone"."subprofile_id" = $1')) {
        return Promise.resolve([
          milestoneRow(NEWER_ID, '2026-10-21T09:00:00.000Z', 250),
          milestoneRow(OLDER_ID, '2026-10-01T09:00:00.000Z', 100),
        ]);
      }
      return Promise.resolve([]);
    });
    andWhereCalls = [];
    andWhereParameters = [];
    queryBuilder = {
      select: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      getOne: jest.fn().mockResolvedValue(personaRow('dj')),
    };
    queryBuilder.select.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockImplementation(
      (condition: string, parameters?: unknown) => {
        andWhereCalls.push(condition);
        if (parameters !== undefined) andWhereParameters.push(parameters);
        return queryBuilder;
      },
    );
    subprofiles = {
      findOne: jest.fn().mockResolvedValue(personaRow('dj')),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    ownership = { isPersonaMember: jest.fn().mockResolvedValue(false) };
    service = new StudioArtistMilestonesService(
      { query } as unknown as DataSource,
      subprofiles as unknown as Repository<Subprofile>,
      ownership as unknown as StudioOwnershipService,
    );
  });

  describe('listMilestones', () => {
    it('answers 404 Artist not found to a non-member, before reading anything', async () => {
      ownership.isPersonaMember.mockResolvedValue(false);
      const failure = service.listMilestones(VIEWER_ID, PERSONA_ID);
      await expect(failure).rejects.toBeInstanceOf(NotFoundException);
      await expect(failure).rejects.toThrow('Artist not found');
      expect(ownership.isPersonaMember).toHaveBeenCalledWith(
        VIEWER_ID,
        PERSONA_ID,
      );
      expect(query).not.toHaveBeenCalled();
    });

    it('reads the persona milestones newest first, at most fifty', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      const response = await service.listMilestones(OWNER_ID, PERSONA_ID);
      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(
          /ORDER BY "milestone"\."reached_at" DESC, "milestone"\."threshold" DESC, "milestone"\."id" DESC\s+LIMIT \$2/,
        ),
        [PERSONA_ID, 50],
      );
      expect(response.items.map((item) => item.id)).toEqual([
        NEWER_ID,
        OLDER_ID,
      ]);
      expect(response.items[0]).toEqual({
        id: NEWER_ID,
        kind: 'followers',
        threshold: 250,
        track: null,
        reachedAt: '2026-10-21T09:00:00.000Z',
      });
    });

    it('orders rows that share a reached date by threshold, biggest first, before the id', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      await service.listMilestones(OWNER_ID, PERSONA_ID);
      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(
          /ORDER BY[^;]*"milestone"\."reached_at" DESC[^;]*"milestone"\."threshold" DESC[^;]*"milestone"\."id" DESC/,
        ),
        [PERSONA_ID, 50],
      );
      expect(query).not.toHaveBeenCalledWith(
        expect.stringMatching(/"milestone"\."id" DESC[^;]*"threshold" DESC/),
        expect.anything(),
      );
    });
  });

  describe('getMilestoneCard', () => {
    it('answers studio_milestone_not_found for an id that is not a uuid, before reading anything', async () => {
      const body = await refusalBody(() =>
        service.getMilestoneCard(VIEWER_ID, 'not-a-uuid'),
      );
      expect(body).toMatchObject({ code: 'studio_milestone_not_found' });
      expect(query).not.toHaveBeenCalled();
      expect(ownership.isPersonaMember).not.toHaveBeenCalled();
    });

    it('answers studio_milestone_not_found for an unknown id', async () => {
      const body = await refusalBody(() =>
        service.getMilestoneCard(VIEWER_ID, UNKNOWN_ID),
      );
      expect(body).toMatchObject({ code: 'studio_milestone_not_found' });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE "milestone"."id" = $1'),
        [UNKNOWN_ID],
      );
      expect(ownership.isPersonaMember).not.toHaveBeenCalled();
    });

    it('serves a persona member without the listenable check', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      expect(await service.getMilestoneCard(OWNER_ID, MILESTONE_ID)).toEqual({
        milestone: FOLLOWER_MILESTONE,
        artist: {
          id: PERSONA_ID,
          handle: 'night-shift',
          name: 'Night Shift',
          kind: 'dj',
          avatarUrl: null,
        },
      });
      expect(ownership.isPersonaMember).toHaveBeenCalledWith(
        OWNER_ID,
        PERSONA_ID,
      );
      expect(subprofiles.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PERSONA_ID } }),
      );
      expect(subprofiles.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses a persona member when the persona kind is outside the artist kinds', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      subprofiles.findOne.mockResolvedValue(personaRow('developer'));
      const body = await refusalBody(() =>
        service.getMilestoneCard(OWNER_ID, MILESTONE_ID),
      );
      expect(body).toMatchObject({ code: 'studio_milestone_not_found' });
    });

    it('reads a non-member through the listenable rule and the block check against every member', async () => {
      const card = await service.getMilestoneCard(VIEWER_ID, MILESTONE_ID);
      expect(card.milestone).toEqual(FOLLOWER_MILESTONE);
      expect(subprofiles.findOne).not.toHaveBeenCalled();
      expect(subprofiles.createQueryBuilder).toHaveBeenCalledWith('persona');
      expect(queryBuilder.where).toHaveBeenCalledWith(
        '"persona"."id" = :subprofileId',
        { subprofileId: PERSONA_ID },
      );
      expect(andWhereCalls.join(' ')).toContain('"visibility"');
      expect(andWhereCalls.join(' ')).toContain('"blocks"');
      expect(andWhereCalls.join(' ')).toContain('"subprofile_members"');
      expect(andWhereCalls.join(' ')).toContain(':viewerId');
      expect(andWhereParameters).toContainEqual({ viewerId: VIEWER_ID });
    });

    it('answers every refusal with the same 404 body', async () => {
      const unknownBody = await refusalBody(() =>
        service.getMilestoneCard(VIEWER_ID, UNKNOWN_ID),
      );
      queryBuilder.getOne.mockResolvedValueOnce(null);
      const unlistenableBody = await refusalBody(() =>
        service.getMilestoneCard(VIEWER_ID, MILESTONE_ID),
      );
      queryBuilder.getOne.mockResolvedValueOnce(personaRow('developer'));
      const otherKindBody = await refusalBody(() =>
        service.getMilestoneCard(VIEWER_ID, MILESTONE_ID),
      );
      const bodies = [
        await refusalBody(() =>
          service.getMilestoneCard(VIEWER_ID, 'not-a-uuid'),
        ),
        unknownBody,
        unlistenableBody,
        otherKindBody,
      ];
      for (const body of bodies) {
        expect(body).toEqual({
          statusCode: 404,
          code: 'studio_milestone_not_found',
          message: 'This milestone is not available to you.',
        });
      }
    });

    it('puts no member id on the card', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      const memberCard = await service.getMilestoneCard(OWNER_ID, MILESTONE_ID);
      ownership.isPersonaMember.mockResolvedValue(false);
      const listenerCard = await service.getMilestoneCard(
        VIEWER_ID,
        MILESTONE_ID,
      );
      for (const card of [memberCard, listenerCard]) {
        expect(JSON.stringify(card)).not.toContain(OWNER_ID);
        expect(JSON.stringify(card)).not.toContain('userId');
        expect(JSON.stringify(card)).not.toContain('subprofile_id');
      }
    });
  });
});
