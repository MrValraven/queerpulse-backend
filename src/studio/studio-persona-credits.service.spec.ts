import { HttpException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import {
  StudioPersonaCredit,
  StudioPersonaCreditState,
} from './entities/studio-persona-credit.entity';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioOwnershipService } from './studio-ownership.service';
import { STUDIO_CREDIT_REQUESTED } from './studio-persona-credit.events';
import {
  CREDIT_CANDIDATE_SQL,
  OWNER_CREDIT_ROWS_SQL,
  StudioPersonaCreditsService,
  normalizeCreditHandle,
} from './studio-persona-credits.service';

const VIEWER_ID = 'e2000000-0000-4000-8000-000000000001';
const RELEASE_PERSONA = 'e2000000-0000-4000-8000-000000000002';
const CREDITED_PERSONA = 'e2000000-0000-4000-8000-000000000003';
const RELEASE_ID = 'e2000000-0000-4000-8000-000000000004';
const TRACK_ID = 'e2000000-0000-4000-8000-000000000005';
const CREDIT_ID = 'e2000000-0000-4000-8000-000000000006';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const candidateRow = (
  personaId = CREDITED_PERSONA,
  kind = 'visual_artist',
) => ({
  persona_id: personaId,
  persona_handle: 'river-ink',
  persona_display_name: 'River Ink',
  persona_kind: kind,
  persona_avatar_url: null,
});

const ownerRow = (status: string) => ({
  id: CREDIT_ID,
  role: 'cover-art',
  status,
  created_at: new Date('2026-10-13T09:00:00.000Z'),
  is_persona_public: true,
  is_persona_linkable: true,
  ...candidateRow(),
});

describe('normalizeCreditHandle', () => {
  it('drops one leading @, trims and lowercases', () => {
    expect(normalizeCreditHandle(' @River-Ink ')).toBe('river-ink');
    expect(normalizeCreditHandle('@@river')).toBe('@river');
  });

  it('answers null for an empty handle or one longer than 60', () => {
    expect(normalizeCreditHandle('')).toBeNull();
    expect(normalizeCreditHandle(' @ ')).toBeNull();
    expect(normalizeCreditHandle('x'.repeat(61))).toBeNull();
    expect(normalizeCreditHandle('x'.repeat(60))).toBe('x'.repeat(60));
  });
});

describe('StudioPersonaCreditsService', () => {
  let query: jest.Mock;
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let ownership: { isPersonaMember: jest.Mock; lockReleaseForWrite: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let releaseStatus: StudioReleaseStatus;
  let service: StudioPersonaCreditsService;

  beforeEach(() => {
    releaseStatus = StudioReleaseStatus.Published;
    query = jest.fn().mockResolvedValue([]);
    manager = {
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql === CREDIT_CANDIDATE_SQL
            ? [candidateRow()]
            : [ownerRow('pending')],
        ),
      ),
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === StudioTrack
            ? { id: TRACK_ID, releaseId: RELEASE_ID }
            : {
                id: CREDIT_ID,
                status: StudioPersonaCreditState.Pending,
                requesterDismissedAt: null,
              },
        ),
      ),
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ ...row, id: CREDIT_ID }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    ownership = {
      isPersonaMember: jest.fn().mockResolvedValue(true),
      lockReleaseForWrite: jest.fn(() =>
        Promise.resolve({
          release: {
            id: RELEASE_ID,
            subprofileId: RELEASE_PERSONA,
            status: releaseStatus,
          },
          persona: { id: RELEASE_PERSONA, kind: 'musician' },
        }),
      ),
    };
    eventEmitter = { emit: jest.fn() };
    const dataSource = {
      query,
      manager,
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioPersonaCreditsService(
      dataSource as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('findCandidate', () => {
    it('answers the public card of an exact handle', async () => {
      const candidate = await service.findCandidate(VIEWER_ID, '@River-Ink');
      expect(manager.query).toHaveBeenCalledWith(CREDIT_CANDIDATE_SQL, [
        VIEWER_ID,
        'river-ink',
      ]);
      expect(candidate).toEqual({
        id: CREDITED_PERSONA,
        handle: 'river-ink',
        name: 'River Ink',
        kind: 'visual_artist',
        avatarUrl: null,
        isListenable: false,
      });
    });

    // The same answer `/p/<handle>` gives: an unknown handle, a private
    // persona and a blocked creator all read alike, so a handle stays
    // unconfirmed.
    it('answers 404 for a persona the public rule or a block keeps out', async () => {
      manager.query.mockResolvedValue([]);
      expect(await codeOf(service.findCandidate(VIEWER_ID, 'river-ink'))).toBe(
        'studio_credit_candidate_not_found',
      );
      expect(CREDIT_CANDIDATE_SQL).toContain(`"persona"."handle" = $2`);
      expect(CREDIT_CANDIDATE_SQL).toContain(`"persona"."visibility" = 'open'`);
      expect(CREDIT_CANDIDATE_SQL).toContain('FROM "blocks" "candidate_block"');
      expect(CREDIT_CANDIDATE_SQL).not.toContain('ILIKE');
    });

    it('answers 404 for an empty handle without asking the database', async () => {
      expect(await codeOf(service.findCandidate(VIEWER_ID, '@'))).toBe(
        'studio_credit_candidate_not_found',
      );
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe('listForTrack', () => {
    it('lists the rows of a track to a member of the release persona, dismissed rows left out', async () => {
      query
        .mockResolvedValueOnce([
          { track_id: TRACK_ID, release_subprofile_id: RELEASE_PERSONA },
        ])
        .mockResolvedValueOnce([ownerRow('declined')]);

      const result = await service.listForTrack(VIEWER_ID, TRACK_ID);

      expect(ownership.isPersonaMember).toHaveBeenCalledWith(
        VIEWER_ID,
        RELEASE_PERSONA,
      );
      expect(query).toHaveBeenLastCalledWith(OWNER_CREDIT_ROWS_SQL, [
        TRACK_ID,
        null,
        VIEWER_ID,
      ]);
      expect(OWNER_CREDIT_ROWS_SQL).toContain(
        '"credit"."requester_dismissed_at" IS NULL',
      );
      // The chip link fails closed on a block, so it never opens an artist
      // page that answers this viewer 404.
      expect(OWNER_CREDIT_ROWS_SQL).toContain(
        'FROM "blocks" "owner_row_block"',
      );
      expect(OWNER_CREDIT_ROWS_SQL).toContain('AS "is_persona_linkable"');
      expect(result.items.map((item) => item.status)).toEqual(['declined']);
    });

    it('answers 404 for a missing track and for a viewer outside the release persona', async () => {
      query.mockResolvedValueOnce([]);
      await expect(
        service.listForTrack(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      query.mockResolvedValueOnce([
        { track_id: TRACK_ID, release_subprofile_id: RELEASE_PERSONA },
      ]);
      ownership.isPersonaMember.mockResolvedValue(false);
      await expect(
        service.listForTrack(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    const body = { handle: '@river-ink', role: 'cover-art' as const };

    it('stores a request as pending whoever owns the credited persona', async () => {
      const row = await service.create(VIEWER_ID, TRACK_ID, body);

      expect(ownership.lockReleaseForWrite).toHaveBeenCalledWith(
        manager,
        VIEWER_ID,
        RELEASE_ID,
      );
      expect(manager.create).toHaveBeenCalledWith(StudioPersonaCredit, {
        trackId: TRACK_ID,
        subprofileId: CREDITED_PERSONA,
        role: 'cover-art',
        status: StudioPersonaCreditState.Pending,
        requestedBySubprofileId: RELEASE_PERSONA,
        requestedByUserId: VIEWER_ID,
      });
      expect(row.status).toBe('pending');
    });

    it('tells the alert listener once the request has committed', async () => {
      await service.create(VIEWER_ID, TRACK_ID, body);
      expect(eventEmitter.emit).toHaveBeenCalledWith(STUDIO_CREDIT_REQUESTED, {
        creditId: CREDIT_ID,
        requestingUserId: VIEWER_ID,
      });
      const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
      const emitOrder = eventEmitter.emit.mock.invocationCallOrder[0] ?? 0;
      expect(saveOrder).toBeLessThan(emitOrder);
    });

    it('answers 404 for a missing track', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.create(VIEWER_ID, TRACK_ID, body),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // The release lock says "Release not found" to a non-member; on a track
    // route that would tell an existing draft track from a missing one.
    it('answers a non-member the same "Track not found" for an existing track, on create and on remove', async () => {
      ownership.lockReleaseForWrite.mockRejectedValue(
        new NotFoundException('Release not found'),
      );
      await expect(service.create(VIEWER_ID, TRACK_ID, body)).rejects.toThrow(
        new NotFoundException('Track not found'),
      );
      await expect(
        service.removeFromTrack(VIEWER_ID, TRACK_ID, CREDIT_ID),
      ).rejects.toThrow(new NotFoundException('Track not found'));

      manager.findOne.mockResolvedValue(null);
      await expect(service.create(VIEWER_ID, TRACK_ID, body)).rejects.toThrow(
        new NotFoundException('Track not found'),
      );
    });

    it('refuses a taken-down release', async () => {
      releaseStatus = StudioReleaseStatus.TakenDown;
      expect(await codeOf(service.create(VIEWER_ID, TRACK_ID, body))).toBe(
        'studio_release_not_draft',
      );
    });

    it('refuses a handle the candidate rule keeps out with 422', async () => {
      manager.query.mockResolvedValue([]);
      expect(await codeOf(service.create(VIEWER_ID, TRACK_ID, body))).toBe(
        'studio_credit_persona_not_creditable',
      );
    });

    // Another persona the same member runs is an ordinary candidate (the
    // pending test above); the release's own persona is refused.
    it("refuses the release's own persona as a credit", async () => {
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql === CREDIT_CANDIDATE_SQL
            ? [candidateRow(RELEASE_PERSONA, 'musician')]
            : [ownerRow('pending')],
        ),
      );
      expect(await codeOf(service.create(VIEWER_ID, TRACK_ID, body))).toBe(
        'studio_credit_self_persona',
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a repeat of the same track, persona and role, a dismissed decline included', async () => {
      manager.exists.mockResolvedValue(true);
      expect(await codeOf(service.create(VIEWER_ID, TRACK_ID, body))).toBe(
        'studio_credit_already_requested',
      );
      expect(manager.exists).toHaveBeenCalledWith(StudioPersonaCredit, {
        where: {
          trackId: TRACK_ID,
          subprofileId: CREDITED_PERSONA,
          role: 'cover-art',
        },
      });
    });

    it('refuses a twenty-first persona credit on a track', async () => {
      manager.count.mockResolvedValue(20);
      expect(await codeOf(service.create(VIEWER_ID, TRACK_ID, body))).toBe(
        'studio_credit_limit',
      );
    });

    it('leaves requester-dismissed declines out of the twenty credit limit', async () => {
      // 19 visible rows plus 3 dismissed declines on the track.
      manager.count.mockImplementation(
        (_entity: unknown, options: { where: Record<string, unknown> }) =>
          Promise.resolve('requesterDismissedAt' in options.where ? 19 : 22),
      );
      const row = await service.create(VIEWER_ID, TRACK_ID, body);
      expect(row.status).toBe('pending');
      expect(manager.count).toHaveBeenCalledWith(StudioPersonaCredit, {
        where: { trackId: TRACK_ID, requesterDismissedAt: IsNull() },
      });
    });
  });

  describe('removeFromTrack', () => {
    it('deletes a pending or accepted row', async () => {
      await service.removeFromTrack(VIEWER_ID, TRACK_ID, CREDIT_ID);
      expect(manager.delete).toHaveBeenCalledWith(StudioPersonaCredit, {
        id: CREDIT_ID,
      });
    });

    it('dismisses a declined row so it still blocks a repeat request', async () => {
      manager.findOne.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === StudioTrack
            ? { id: TRACK_ID, releaseId: RELEASE_ID }
            : {
                id: CREDIT_ID,
                status: StudioPersonaCreditState.Declined,
                requesterDismissedAt: null,
              },
        ),
      );
      await service.removeFromTrack(VIEWER_ID, TRACK_ID, CREDIT_ID);
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(
        StudioPersonaCredit,
        { id: CREDIT_ID },
        { requesterDismissedAt: expect.any(Date) },
      );
    });

    it('reads the credit by its id on this track only, under a row lock', async () => {
      await service.removeFromTrack(VIEWER_ID, TRACK_ID, CREDIT_ID);
      expect(manager.findOne).toHaveBeenCalledWith(StudioPersonaCredit, {
        where: { id: CREDIT_ID, trackId: TRACK_ID },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('answers 404 for a credit of another track', async () => {
      manager.findOne.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === StudioTrack
            ? { id: TRACK_ID, releaseId: RELEASE_ID }
            : null,
        ),
      );
      expect(
        await codeOf(service.removeFromTrack(VIEWER_ID, TRACK_ID, CREDIT_ID)),
      ).toBe('studio_credit_not_found');
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('answers 404 for a declined credit already dismissed', async () => {
      manager.findOne.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === StudioTrack
            ? { id: TRACK_ID, releaseId: RELEASE_ID }
            : {
                id: CREDIT_ID,
                status: StudioPersonaCreditState.Declined,
                requesterDismissedAt: new Date(),
              },
        ),
      );
      expect(
        await codeOf(service.removeFromTrack(VIEWER_ID, TRACK_ID, CREDIT_ID)),
      ).toBe('studio_credit_not_found');
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
