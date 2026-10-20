import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import {
  deleteCreatorDraftWithin,
  readCreatorDraftWithin,
  saveCreatorDraftWithin,
} from './creator-draft-store';
import {
  CreatorDraftMadeForService,
  type DraftRef,
  type ManageableListing,
} from './creator-draft-made-for.service';
import { CreatorDraftsService } from './creator-drafts.service';
import type { SaveCreatorDraftDto } from './dto/save-creator-draft.dto';
import type { CreatorDraft } from './entities/creator-draft.entity';

jest.mock('./creator-draft-store', () => ({
  ...jest.requireActual<typeof import('./creator-draft-store')>(
    './creator-draft-store',
  ),
  saveCreatorDraftWithin: jest.fn(),
  readCreatorDraftWithin: jest.fn(),
  deleteCreatorDraftWithin: jest.fn(),
}));

const SAVED_AT = new Date('2026-10-19T10:00:00.000Z');
const LISTING_ID = '6f1c2b8e-4a39-4d1e-9a51-0c3b7e2f9d10';

const COMMUNITY_REF: DraftRef = {
  id: 'community-1',
  slug: 'queer-hikers',
  name: 'Queer Hikers',
};

const MANAGEABLE_LISTING: ManageableListing = {
  id: LISTING_ID,
  ref: 'QPL-2026-0001',
  slug: 'the-pink-door',
  name: 'The Pink Door',
  isLive: true,
};

const BODY: SaveCreatorDraftDto = {
  payload: { title: 'Picnic in the park', communitySlug: 'queer-hikers' },
  payloadVersion: 1,
  baseRevision: 1,
  progress: { done: 2, total: 5 },
  missing: ['startsAt'],
};

const STORED_ROW = {
  payload: { title: 'Picnic in the park' },
  payloadVersion: 1,
  revision: 3,
  updatedAt: SAVED_AT,
} as unknown as CreatorDraft;

describe('CreatorDraftsService', () => {
  const dataSource = { manager: {} as EntityManager } as DataSource;
  const config = {
    get: jest.fn((_key: string, fallback: number) => fallback),
  };
  const madeFor = {
    resolveEventRefs: jest.fn(),
    findManageableListingByRef: jest.fn(),
    findManageableListingById: jest.fn(),
    findListingIdByRef: jest.fn(),
  };
  let service: CreatorDraftsService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
    config.get.mockImplementation((_key: string, fallback: number) => fallback);
    madeFor.resolveEventRefs.mockResolvedValue({
      community: null,
      runByListing: null,
      venueListing: null,
      madeForCommunityId: null,
      madeForListingId: null,
    });
    service = new CreatorDraftsService(
      dataSource,
      config as unknown as ConfigService,
      madeFor as unknown as CreatorDraftMadeForService,
    );
  });

  it('saves an event draft with the made-for refs the server resolved', async () => {
    madeFor.resolveEventRefs.mockResolvedValue({
      community: COMMUNITY_REF,
      runByListing: null,
      venueListing: null,
      madeForCommunityId: 'community-1',
      madeForListingId: null,
    });
    jest
      .mocked(saveCreatorDraftWithin)
      .mockResolvedValue({ isSaved: true, revision: 2, savedAt: SAVED_AT });
    await expect(
      service.saveDraft('member-1', { kind: 'event' }, BODY),
    ).resolves.toEqual({ revision: 2, savedAt: SAVED_AT.toISOString() });
    expect(saveCreatorDraftWithin).toHaveBeenCalledWith(
      dataSource.manager,
      { userId: 'member-1', kind: 'event', slotKey: '' },
      expect.objectContaining({
        madeForCommunityId: 'community-1',
        madeForListingId: null,
        baseRevision: 1,
      }),
      expect.any(Date),
    );
  });

  it('takes the expiry cutoff from the configured retention window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T02:00:00Z'));
    try {
      config.get.mockImplementation((key: string, fallback: number) =>
        key === 'retention.creatorDraftDays' ? 30 : fallback,
      );
      jest
        .mocked(saveCreatorDraftWithin)
        .mockResolvedValue({ isSaved: true, revision: 2, savedAt: SAVED_AT });
      await service.saveDraft('member-1', { kind: 'community' }, BODY);
      expect(jest.mocked(saveCreatorDraftWithin).mock.calls[0]?.[3]).toEqual(
        new Date('2026-09-19T02:00:00Z'),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers 409 with the current revision and saved time', async () => {
    jest.mocked(saveCreatorDraftWithin).mockResolvedValue({
      isSaved: false,
      current: { revision: 5, savedAt: SAVED_AT },
    });
    const error = await service
      .saveDraft('member-1', { kind: 'community' }, BODY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'creator_draft_revision_conflict',
        revision: 5,
        savedAt: SAVED_AT.toISOString(),
      }),
    );
  });

  it('answers 409 with a null revision for a base on an empty slot', async () => {
    jest
      .mocked(saveCreatorDraftWithin)
      .mockResolvedValue({ isSaved: false, current: null });
    await expect(
      service.saveDraft('member-1', { kind: 'event' }, BODY),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        revision: null,
        savedAt: null,
      }) as unknown,
    });
  });

  it('refuses a payload over 96 KiB before any read', async () => {
    const body = { ...BODY, payload: { title: 'é'.repeat(49_200) } };
    await expect(
      service.saveDraft('member-1', { kind: 'event' }, body),
    ).rejects.toMatchObject({ status: 413 });
    expect(madeFor.resolveEventRefs).not.toHaveBeenCalled();
    expect(saveCreatorDraftWithin).not.toHaveBeenCalled();
  });

  it('refuses progress past its total', async () => {
    await expect(
      service.saveDraft(
        'member-1',
        { kind: 'community' },
        { ...BODY, progress: { done: 6, total: 5 } },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saveCreatorDraftWithin).not.toHaveBeenCalled();
  });

  it.each([
    ['a payload value', { payload: { title: `Picnic${'\u0000'}` } }],
    ['a payload key', { payload: { [`title${'\u0000'}`]: 'Picnic' } }],
    ['a missing code', { missing: [`startsAt${'\u0000'}`] }],
  ])(
    'refuses a NUL character in %s before saving',
    async (_label, overrides) => {
      const error = await service
        .saveDraft('member-1', { kind: 'event' }, { ...BODY, ...overrides })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        JSON.stringify((error as BadRequestException).getResponse()),
      ).not.toContain('Picnic');
      expect(madeFor.resolveEventRefs).not.toHaveBeenCalled();
      expect(saveCreatorDraftWithin).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a payload value', { payload: { title: `Picnic${'\ud800'}` } }],
    ['a payload key', { payload: { [`title${'\udc00'}`]: 'Picnic' } }],
    ['a missing code', { missing: [`startsAt${'\udbff'}`] }],
  ])(
    'refuses an unpaired surrogate in %s before saving',
    async (_label, overrides) => {
      const error = await service
        .saveDraft('member-1', { kind: 'event' }, { ...BODY, ...overrides })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        JSON.stringify((error as BadRequestException).getResponse()),
      ).not.toContain('Picnic');
      expect(madeFor.resolveEventRefs).not.toHaveBeenCalled();
      expect(saveCreatorDraftWithin).not.toHaveBeenCalled();
    },
  );

  it('keeps paired surrogates and the escaped text \\ud800', async () => {
    jest
      .mocked(saveCreatorDraftWithin)
      .mockResolvedValue({ isSaved: true, revision: 2, savedAt: SAVED_AT });
    await expect(
      service.saveDraft(
        'member-1',
        { kind: 'community' },
        {
          ...BODY,
          payload: { title: 'Picnic \ud83c\udf08', path: 'C:\\ud800' },
          missing: ['startsAt'],
        },
      ),
    ).resolves.toEqual({ revision: 2, savedAt: SAVED_AT.toISOString() });
  });

  it('keeps an escaped backslash followed by the text u0000', async () => {
    jest
      .mocked(saveCreatorDraftWithin)
      .mockResolvedValue({ isSaved: true, revision: 2, savedAt: SAVED_AT });
    await expect(
      service.saveDraft(
        'member-1',
        { kind: 'community' },
        {
          ...BODY,
          payload: { path: 'C:\\u0000' },
        },
      ),
    ).resolves.toEqual({ revision: 2, savedAt: SAVED_AT.toISOString() });
  });

  it('keys a listing edit by the listing id and answers 404 for a listing the caller cannot manage', async () => {
    madeFor.findManageableListingByRef
      .mockResolvedValueOnce(MANAGEABLE_LISTING)
      .mockResolvedValueOnce(null);
    jest
      .mocked(saveCreatorDraftWithin)
      .mockResolvedValue({ isSaved: true, revision: 1, savedAt: SAVED_AT });
    await service.saveDraft(
      'member-1',
      { kind: 'listing_edit', listingRef: 'QPL-2026-0001' },
      { ...BODY, baseRevision: null },
    );
    const listingEditCall = jest.mocked(saveCreatorDraftWithin).mock.calls[0];
    expect(listingEditCall?.[1]).toEqual({
      userId: 'member-1',
      kind: 'listing_edit',
      slotKey: LISTING_ID,
    });
    expect(listingEditCall?.[2]).toEqual(
      expect.objectContaining({
        madeForListingId: LISTING_ID,
        madeForCommunityId: null,
      }),
    );
    expect(madeFor.resolveEventRefs).not.toHaveBeenCalled();
    await expect(
      service.getDraft('member-1', {
        kind: 'listing_edit',
        listingRef: 'QPL-2026-0009',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'creator_draft_listing_unavailable',
        message: expect.any(String) as string,
      },
    });
    expect(readCreatorDraftWithin).not.toHaveBeenCalled();
  });

  it('reads null for an empty or expired slot and the stored draft otherwise', async () => {
    jest
      .mocked(readCreatorDraftWithin)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(STORED_ROW);
    await expect(
      service.getDraft('member-1', { kind: 'event' }),
    ).resolves.toEqual({ draft: null });
    await expect(
      service.getDraft('member-1', { kind: 'event' }),
    ).resolves.toEqual({
      draft: {
        payload: STORED_ROW.payload,
        payloadVersion: 1,
        revision: 3,
        savedAt: STORED_ROW.updatedAt.toISOString(),
      },
    });
  });

  it('discards a listing edit by listing id even after the caller lost management', async () => {
    madeFor.findListingIdByRef.mockResolvedValue(LISTING_ID);
    await service.discardDraft('member-1', {
      kind: 'listing_edit',
      listingRef: 'QPL-2026-0001',
    });
    expect(madeFor.findListingIdByRef).toHaveBeenCalledWith('QPL-2026-0001');
    expect(madeFor.findManageableListingByRef).not.toHaveBeenCalled();
    expect(deleteCreatorDraftWithin).toHaveBeenCalledWith(dataSource.manager, {
      userId: 'member-1',
      kind: 'listing_edit',
      slotKey: LISTING_ID,
    });
  });

  it('answers 404 on a discard for an unknown or malformed listing ref', async () => {
    madeFor.findListingIdByRef.mockResolvedValue(null);
    await expect(
      service.discardDraft('member-1', {
        kind: 'listing_edit',
        listingRef: 'not-a-ref',
      }),
    ).rejects.toMatchObject({
      response: { code: 'creator_draft_listing_unavailable' },
    });
    expect(deleteCreatorDraftWithin).not.toHaveBeenCalled();
  });

  it('keeps the manage check on a listing edit read and save', async () => {
    madeFor.findManageableListingByRef.mockResolvedValue(null);
    madeFor.findListingIdByRef.mockResolvedValue(LISTING_ID);
    const target = {
      kind: 'listing_edit' as const,
      listingRef: 'QPL-2026-0001',
    };
    await expect(service.getDraft('member-1', target)).rejects.toMatchObject({
      response: { code: 'creator_draft_listing_unavailable' },
    });
    await expect(
      service.saveDraft('member-1', target, BODY),
    ).rejects.toMatchObject({
      response: { code: 'creator_draft_listing_unavailable' },
    });
    expect(madeFor.findListingIdByRef).not.toHaveBeenCalled();
    expect(readCreatorDraftWithin).not.toHaveBeenCalled();
    expect(saveCreatorDraftWithin).not.toHaveBeenCalled();
  });

  it('deletes only the caller slot and answers the same twice', async () => {
    await service.discardDraft('member-1', { kind: 'community' });
    await service.discardDraft('member-1', { kind: 'community' });
    expect(deleteCreatorDraftWithin).toHaveBeenCalledWith(dataSource.manager, {
      userId: 'member-1',
      kind: 'community',
      slotKey: '',
    });
  });

  it('never hands a payload to a logger', async () => {
    const logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(),
    );
    jest
      .mocked(saveCreatorDraftWithin)
      .mockResolvedValue({ isSaved: true, revision: 2, savedAt: SAVED_AT });
    await service.saveDraft('member-1', { kind: 'community' }, BODY);
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
