import {
  type CreatorDraftSlot,
  type CreatorDraftWrite,
  creatorDraftExpiryCutoff,
  saveCreatorDraftWithin,
} from './creator-draft-store';

const SAVED_AT = new Date('2026-10-19T10:00:00.000Z');
const CUTOFF = new Date('2026-07-21T10:00:00.000Z');

const SLOT: CreatorDraftSlot = {
  userId: 'c9000000-0000-4000-8000-000000000001',
  kind: 'event',
  slotKey: '',
};

const WRITE: CreatorDraftWrite = {
  payload: { title: 'Picnic in the park' },
  payloadVersion: 1,
  baseRevision: null,
  progress: { done: 2, total: 5 },
  missing: ['who'],
  madeForCommunityId: 'community-1',
  madeForListingId: null,
};

describe('creator draft store', () => {
  it('inserts when the base revision is null and reports revision one', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ revision: 1, updated_at: SAVED_AT }]);
    const outcome = await saveCreatorDraftWithin(
      { query } as never,
      SLOT,
      { ...WRITE, baseRevision: null },
      CUTOFF,
    );
    expect(outcome).toEqual({ isSaved: true, revision: 1, savedAt: SAVED_AT });
    expect(String(query.mock.calls[0][0])).toMatch(
      /ON CONFLICT \("user_id", "kind", "slot_key"\) DO UPDATE/,
    );
    expect(String(query.mock.calls[0][0])).toContain(
      'DO UPDATE SET\n  "id" = uuid_generate_v4(),',
    );
    expect(query.mock.calls[0][1]).toEqual([
      SLOT.userId,
      'event',
      '',
      WRITE.payload,
      1,
      'community-1',
      null,
      2,
      5,
      ['who'],
      CUTOFF,
    ]);
  });

  it('updates only the row at the base revision and inside the window', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([[{ revision: 5, updated_at: SAVED_AT }], 1]);
    const outcome = await saveCreatorDraftWithin(
      { query } as never,
      SLOT,
      { ...WRITE, baseRevision: 4 },
      CUTOFF,
    );
    expect(outcome).toEqual({ isSaved: true, revision: 5, savedAt: SAVED_AT });
    expect(String(query.mock.calls[0][0])).toMatch(
      /"revision" = \$11 AND "updated_at" >= \$12/,
    );
    expect((query.mock.calls[0][1] as unknown[]).slice(10)).toEqual([
      4,
      CUTOFF,
    ]);
  });

  it('reports the live row and writes nothing when the update matches no row', async () => {
    const query = jest.fn().mockResolvedValueOnce([[], 0]);
    const findOne = jest
      .fn()
      .mockResolvedValue({ revision: 7, updatedAt: SAVED_AT });
    const outcome = await saveCreatorDraftWithin(
      { query, getRepository: () => ({ findOne }) } as never,
      SLOT,
      { ...WRITE, baseRevision: 4 },
      CUTOFF,
    );
    expect(outcome).toEqual({
      isSaved: false,
      current: { revision: 7, savedAt: SAVED_AT },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('writes both progress columns null and reports an empty slot as a null current', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const findOne = jest.fn().mockResolvedValue(null);
    const outcome = await saveCreatorDraftWithin(
      { query, getRepository: () => ({ findOne }) } as never,
      SLOT,
      { ...WRITE, baseRevision: null, progress: null },
      CUTOFF,
    );
    expect(outcome).toEqual({ isSaved: false, current: null });
    expect((query.mock.calls[0][1] as unknown[]).slice(7, 9)).toEqual([
      null,
      null,
    ]);
  });

  it('puts the expiry cutoff the configured number of days back', () => {
    expect(
      creatorDraftExpiryCutoff(
        new Date('2026-10-19T00:00:00Z'),
        90,
      ).toISOString(),
    ).toBe('2026-07-21T00:00:00.000Z');
  });
});
