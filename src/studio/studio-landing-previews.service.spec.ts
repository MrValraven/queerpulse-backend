import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import {
  resetStudioLandingMemoForTesting,
  studioLandingMemoGeneration,
} from './studio-landing-memo';
import {
  OWNER_PERSONA_SQL,
  OWNER_PREVIEW_LIST_SQL,
  OWNER_PREVIEW_ROW_SQL,
  OWNER_PREVIEW_UPDATE_SQL,
  StudioLandingPreviewsService,
} from './studio-landing-previews.service';
import { OwnerPreviewRow } from './studio-landing-response';
import { StudioOwnershipService } from './studio-ownership.service';
import { STUDIO_LANDING_PREVIEW_APPROVED } from './studio.events';

const MEMBER_ID = 'fc000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'fc000000-0000-4000-8000-000000000101';
const PREVIEW_ID = 'fc000000-0000-4000-8000-000000000201';
const TRACK_ID = 'fc000000-0000-4000-8000-000000000301';
const RELEASE_ID = 'fc000000-0000-4000-8000-000000000401';

const REQUESTED_AT = new Date('2026-10-20T10:00:00.000Z');
const DECIDED_AT = new Date('2026-10-21T12:30:00.000Z');

function ownerRow(overrides: Partial<OwnerPreviewRow>): OwnerPreviewRow {
  return {
    id: PREVIEW_ID,
    status: 'pending',
    relation: 'main',
    track_id: TRACK_ID,
    track_title: 'Harbour',
    track_duration_seconds: 200,
    release_id: RELEASE_ID,
    release_title: 'Low tide',
    release_cover_key: null,
    main_artist_id: PERSONA_ID,
    main_artist_handle: 'harbour-lights',
    main_artist_display_name: 'Harbour Lights',
    main_artist_kind: 'musician',
    main_artist_avatar_url: null,
    requested_at: REQUESTED_AT,
    decided_at: null,
    is_eligible: true,
    ...overrides,
  };
}

describe('StudioLandingPreviewsService', () => {
  let service: StudioLandingPreviewsService;
  let query: jest.Mock;
  let isPersonaMember: jest.Mock;
  let eventEmitter: { emit: jest.Mock };
  let personaRows: { id: string; kind: string }[];
  let rowQueue: OwnerPreviewRow[][];
  let listRows: OwnerPreviewRow[];
  let updatedRows: { id: string }[];

  /** The row reads answer in order: the read before the write, then the read after it. */
  const rowRelation = (...rows: Partial<OwnerPreviewRow>[]): void => {
    rowQueue = rows.map((overrides) => [ownerRow(overrides)]);
  };

  const updateReturns = (rows: { id: string }[]): void => {
    updatedRows = rows;
  };

  const callsOf = (sql: string): unknown[][] =>
    query.mock.calls.filter((call: unknown[]) => call[0] === sql);

  beforeEach(() => {
    resetStudioLandingMemoForTesting();
    personaRows = [{ id: PERSONA_ID, kind: 'musician' }];
    rowQueue = [];
    listRows = [];
    updatedRows = [{ id: PREVIEW_ID }];
    query = jest.fn((sql: string) => {
      if (sql === OWNER_PERSONA_SQL) {
        return Promise.resolve(personaRows);
      }
      if (sql === OWNER_PREVIEW_LIST_SQL) {
        return Promise.resolve(listRows);
      }
      if (sql === OWNER_PREVIEW_ROW_SQL) {
        return Promise.resolve(rowQueue.shift() ?? []);
      }
      if (sql === OWNER_PREVIEW_UPDATE_SQL) {
        return Promise.resolve(updatedRows);
      }
      return Promise.reject(new Error(`Unexpected query: ${sql}`));
    });
    isPersonaMember = jest.fn().mockResolvedValue(true);
    eventEmitter = { emit: jest.fn() };
    service = new StudioLandingPreviewsService(
      { query } as unknown as DataSource,
      { isPersonaMember } as unknown as StudioOwnershipService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  afterEach(() => {
    resetStudioLandingMemoForTesting();
  });

  it('answers 404 Artist not found to a caller who is not a persona member, before any read', async () => {
    isPersonaMember.mockResolvedValue(false);
    await expect(service.listForPersona(MEMBER_ID, PERSONA_ID)).rejects.toThrow(
      new NotFoundException('Artist not found'),
    );
    await expect(
      service.approve(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toThrow(new NotFoundException('Artist not found'));
    expect(isPersonaMember).toHaveBeenCalledWith(MEMBER_ID, PERSONA_ID);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers 404 Artist not found to an unknown persona', async () => {
    personaRows = [];
    await expect(
      service.withdraw(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toThrow(new NotFoundException('Artist not found'));
    expect(callsOf(OWNER_PREVIEW_ROW_SQL)).toEqual([]);
  });

  it('lists nothing for a persona outside the Studio artist kinds', async () => {
    personaRows = [{ id: PERSONA_ID, kind: 'writer' }];
    expect(await service.listForPersona(MEMBER_ID, PERSONA_ID)).toEqual({
      items: [],
    });
    expect(callsOf(OWNER_PREVIEW_LIST_SQL)).toEqual([]);
  });

  it('lists the rows for the stored persona id', async () => {
    listRows = [
      ownerRow({}),
      ownerRow({
        id: 'fc000000-0000-4000-8000-000000000202',
        status: 'approved',
        relation: 'credited',
        decided_at: DECIDED_AT,
      }),
    ];
    const list = await service.listForPersona(MEMBER_ID, PERSONA_ID);
    expect(
      list.items.map((item) => [item.id, item.status, item.relation]),
    ).toEqual([
      [PREVIEW_ID, 'pending', 'main'],
      ['fc000000-0000-4000-8000-000000000202', 'approved', 'credited'],
    ]);
    expect(callsOf(OWNER_PREVIEW_LIST_SQL)).toEqual([
      [OWNER_PREVIEW_LIST_SQL, [PERSONA_ID]],
    ]);
  });

  it('refuses approve from a credited persona with studio_landing_preview_main_persona_only', async () => {
    rowRelation({ relation: 'credited', status: 'pending' });
    await expect(
      service.approve(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'studio_landing_preview_main_persona_only' },
    });
    expect(callsOf(OWNER_PREVIEW_UPDATE_SQL)).toEqual([]);
  });

  it('refuses decline from a credited persona with studio_landing_preview_main_persona_only', async () => {
    rowRelation({ relation: 'credited', status: 'pending' });
    await expect(
      service.decline(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      response: { code: 'studio_landing_preview_main_persona_only' },
    });
    expect(callsOf(OWNER_PREVIEW_UPDATE_SQL)).toEqual([]);
  });

  it('answers studio_landing_preview_not_found to a preview this persona has no link to', async () => {
    rowRelation();
    await expect(
      service.approve(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'studio_landing_preview_not_found' },
    });
    expect(callsOf(OWNER_PREVIEW_ROW_SQL)).toEqual([
      [OWNER_PREVIEW_ROW_SQL, [PERSONA_ID, PREVIEW_ID]],
    ]);
    expect(callsOf(OWNER_PREVIEW_UPDATE_SQL)).toEqual([]);
  });

  it('answers studio_landing_preview_not_found on a persona outside the Studio artist kinds', async () => {
    personaRows = [{ id: PERSONA_ID, kind: 'writer' }];
    await expect(
      service.withdraw(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      response: { code: 'studio_landing_preview_not_found' },
    });
    expect(callsOf(OWNER_PREVIEW_ROW_SQL)).toEqual([]);
  });

  it('approves only from pending and answers not_pending when another owner answered first', async () => {
    rowRelation(
      { relation: 'main', status: 'pending' },
      { relation: 'main', status: 'declined' },
    ); // before and after
    updateReturns([]);
    await expect(
      service.approve(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'studio_landing_preview_not_pending' },
    });
    expect(callsOf(OWNER_PREVIEW_UPDATE_SQL)).toEqual([
      [
        OWNER_PREVIEW_UPDATE_SQL,
        [PREVIEW_ID, 'approved', MEMBER_ID, 'pending'],
      ],
    ]);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(studioLandingMemoGeneration()).toBe(0);
  });

  it('answers not_found when staff removed the row before the write landed', async () => {
    rowRelation({ relation: 'main', status: 'pending' });
    updateReturns([]);
    await expect(
      service.decline(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      response: { code: 'studio_landing_preview_not_found' },
    });
  });

  it('answers not_pending on a declined row', async () => {
    rowRelation(
      { relation: 'main', status: 'declined' },
      { relation: 'main', status: 'declined' },
    );
    updateReturns([]);
    await expect(
      service.approve(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'studio_landing_preview_not_pending' },
    });
  });

  it('withdraws from a credited persona and answers studio_landing_preview_not_approved for a pending row', async () => {
    rowRelation(
      { relation: 'credited', status: 'approved', decided_at: DECIDED_AT },
      { relation: 'credited', status: 'withdrawn', decided_at: DECIDED_AT },
    );
    const withdrawn = await service.withdraw(MEMBER_ID, PERSONA_ID, PREVIEW_ID);
    expect(withdrawn).toMatchObject({
      status: 'withdrawn',
      relation: 'credited',
      canWithdraw: false,
    });
    expect(callsOf(OWNER_PREVIEW_UPDATE_SQL)).toEqual([
      [
        OWNER_PREVIEW_UPDATE_SQL,
        [PREVIEW_ID, 'withdrawn', MEMBER_ID, 'approved'],
      ],
    ]);

    rowRelation(
      { relation: 'credited', status: 'pending' },
      { relation: 'credited', status: 'pending' },
    );
    updateReturns([]);
    await expect(
      service.withdraw(MEMBER_ID, PERSONA_ID, PREVIEW_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'studio_landing_preview_not_approved' },
    });
  });

  it('emits the approval with the approver after the write and bumps the memo', async () => {
    rowRelation(
      { relation: 'main', status: 'pending' },
      { relation: 'main', status: 'approved', decided_at: DECIDED_AT },
    );
    const updateCountsAtEmit: number[] = [];
    eventEmitter.emit.mockImplementation(() => {
      updateCountsAtEmit.push(callsOf(OWNER_PREVIEW_UPDATE_SQL).length);
      return true;
    });
    await service.approve(MEMBER_ID, PERSONA_ID, PREVIEW_ID);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      STUDIO_LANDING_PREVIEW_APPROVED,
      { previewId: PREVIEW_ID, approverUserId: MEMBER_ID },
    );
    expect(updateCountsAtEmit).toEqual([1]);
    expect(studioLandingMemoGeneration()).toBe(1);
  });

  it('emits nothing on decline and withdraw', async () => {
    rowRelation(
      { relation: 'main', status: 'pending' },
      { relation: 'main', status: 'declined', decided_at: DECIDED_AT },
    );
    await service.decline(MEMBER_ID, PERSONA_ID, PREVIEW_ID);
    rowRelation(
      { relation: 'main', status: 'approved', decided_at: DECIDED_AT },
      { relation: 'main', status: 'withdrawn', decided_at: DECIDED_AT },
    );
    await service.withdraw(MEMBER_ID, PERSONA_ID, PREVIEW_ID);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(studioLandingMemoGeneration()).toBe(2);
  });

  it('answers the row with its new status and no member field', async () => {
    rowRelation(
      { relation: 'main', status: 'pending' },
      { relation: 'main', status: 'approved', decided_at: DECIDED_AT },
    );
    const approved = await service.approve(MEMBER_ID, PERSONA_ID, PREVIEW_ID);
    expect(approved).toEqual({
      id: PREVIEW_ID,
      status: 'approved',
      relation: 'main',
      track: { id: TRACK_ID, title: 'Harbour', durationSeconds: 200 },
      release: { id: RELEASE_ID, title: 'Low tide', coverUrl: null },
      mainArtist: expect.objectContaining({
        id: PERSONA_ID,
        handle: 'harbour-lights',
      }) as unknown,
      requestedAt: REQUESTED_AT.toISOString(),
      decidedAt: DECIDED_AT.toISOString(),
      isEligible: true,
      canApprove: false,
      canDecline: false,
      canWithdraw: true,
    });
    expect(JSON.stringify(approved)).not.toContain(MEMBER_ID);
  });
});
