import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  AdminFoundingArtistRow,
  AdminLandingArtistCardRow,
  AdminLandingPersonaOptionRow,
} from './admin-studio-landing-response';
import {
  AdminStudioLandingContentService,
  normalizeLandingQuote,
} from './admin-studio-landing-content.service';
import {
  resetStudioLandingMemoForTesting,
  studioLandingMemoGeneration,
} from './studio-landing-memo';

const STAFF_ID = 'e8000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'e8000000-0000-4000-8000-000000000011';
const CARD_ID = 'e8000000-0000-4000-8000-000000000021';
const SECOND_CARD_ID = 'e8000000-0000-4000-8000-000000000022';
const FOUNDING_ID = 'e8000000-0000-4000-8000-000000000031';
const SECOND_FOUNDING_ID = 'e8000000-0000-4000-8000-000000000032';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const artistColumns = {
  artist_id: PERSONA_ID,
  artist_handle: 'nova',
  artist_display_name: 'Nova',
  artist_kind: 'musician',
  artist_avatar_url: null,
};

const cardRow: AdminLandingArtistCardRow = {
  ...artistColumns,
  id: CARD_ID,
  quote: 'We sing',
  position: 1,
  consented_at: new Date('2026-10-28T10:00:00.000Z'),
  created_by_id: STAFF_ID,
  is_shown: true,
  is_founding_artist: true,
};

const foundingRow: AdminFoundingArtistRow = {
  ...artistColumns,
  id: FOUNDING_ID,
  position: 1,
  added_by_id: STAFF_ID,
  created_at: new Date('2026-10-28T11:00:00.000Z'),
  is_listed: true,
};

const personaOptionRow: AdminLandingPersonaOptionRow = {
  ...artistColumns,
  is_eligible: true,
  has_card: false,
  is_founding_artist: false,
};

interface Staged {
  cardRows: AdminLandingArtistCardRow[];
  foundingRows: AdminFoundingArtistRow[];
  settingsRows: { is_founding_shelf_visible: boolean }[];
  existingCardIds: string[];
  changedIds: string[];
  currentIds: string[];
  cardState: { is_eligible: boolean; has_card: boolean; card_count: number };
  foundingState: {
    is_eligible: boolean;
    is_listed: boolean;
    listed_count: number;
  };
}

describe('normalizeLandingQuote', () => {
  it('trims and stores an empty quote as null', () => {
    expect(normalizeLandingQuote('  We sing ')).toBe('We sing');
    expect(normalizeLandingQuote('   ')).toBeNull();
    expect(normalizeLandingQuote('')).toBeNull();
    expect(normalizeLandingQuote(null)).toBeNull();
    expect(normalizeLandingQuote(undefined)).toBeNull();
  });
});

describe('AdminStudioLandingContentService', () => {
  let staged: Staged;
  let query: jest.Mock;
  let transaction: jest.Mock;
  let managerQuery: jest.Mock;
  let namesForUserIds: jest.Mock;
  let service: AdminStudioLandingContentService;

  function statementsOf(
    mock: jest.Mock,
    fragment: string,
  ): [string, unknown[]][] {
    return (mock.mock.calls as [string, unknown[]][]).filter(([sql]) =>
      sql.includes(fragment),
    );
  }

  beforeEach(() => {
    resetStudioLandingMemoForTesting();
    staged = {
      cardRows: [cardRow],
      foundingRows: [foundingRow],
      settingsRows: [],
      existingCardIds: [CARD_ID],
      changedIds: [CARD_ID],
      currentIds: [CARD_ID, SECOND_CARD_ID],
      cardState: { is_eligible: true, has_card: false, card_count: 2 },
      foundingState: { is_eligible: true, is_listed: false, listed_count: 2 },
    };
    query = jest.fn((sql: string): Promise<unknown> => {
      if (sql.includes('AS "is_shown"')) {
        return Promise.resolve(staged.cardRows);
      }
      if (sql.includes('"founding"."added_by_id"')) {
        return Promise.resolve(staged.foundingRows);
      }
      if (sql.startsWith('SELECT "is_founding_shelf_visible"')) {
        return Promise.resolve(staged.settingsRows);
      }
      if (sql.includes('"has_card"')) {
        return Promise.resolve([personaOptionRow]);
      }
      if (sql.startsWith('SELECT "id" FROM "studio_landing_artist_cards"')) {
        return Promise.resolve(staged.existingCardIds.map((id) => ({ id })));
      }
      if (sql.includes('WITH "changed"') || sql.includes('WITH "removed"')) {
        return Promise.resolve(staged.changedIds.map((id) => ({ id })));
      }
      return Promise.resolve([]);
    });
    managerQuery = jest.fn((sql: string): Promise<unknown> => {
      if (sql.includes('"card_count"')) {
        return Promise.resolve([staged.cardState]);
      }
      if (sql.includes('"listed_count"')) {
        return Promise.resolve([staged.foundingState]);
      }
      if (sql.startsWith('INSERT INTO "studio_landing_artist_cards"')) {
        return Promise.resolve([{ id: CARD_ID }]);
      }
      if (sql.startsWith('INSERT INTO "studio_founding_artists"')) {
        return Promise.resolve([{ id: FOUNDING_ID }]);
      }
      if (sql.startsWith('SELECT "id" FROM')) {
        return Promise.resolve(staged.currentIds.map((id) => ({ id })));
      }
      return Promise.resolve([]);
    });
    transaction = jest.fn((work: (inner: EntityManager) => unknown) =>
      Promise.resolve(
        work({ query: managerQuery } as unknown as EntityManager),
      ),
    );
    namesForUserIds = jest
      .fn()
      .mockResolvedValue(new Map([[STAFF_ID, 'Ana Staff']]));
    service = new AdminStudioLandingContentService(
      { query, transaction } as unknown as DataSource,
      { namesForUserIds } as unknown as ModAuditService,
    );
  });

  describe('reads', () => {
    it('reads cards, founding rows and settings with one staff name call', async () => {
      staged.settingsRows = [{ is_founding_shelf_visible: false }];
      const content = await service.getContent();
      expect(content.artistCards.map((card) => card.id)).toEqual([CARD_ID]);
      expect(content.artistCards.map((card) => card.createdBy)).toEqual([
        { id: STAFF_ID, displayName: 'Ana Staff' },
      ]);
      expect(content.artistCards.map((card) => card.isShown)).toEqual([true]);
      expect(content.artistCards.map((card) => card.isFoundingArtist)).toEqual([
        true,
      ]);
      expect(content.foundingArtists.map((row) => row.isListed)).toEqual([
        true,
      ]);
      expect(content.foundingArtists.map((row) => row.addedBy)).toEqual([
        { id: STAFF_ID, displayName: 'Ana Staff' },
      ]);
      expect(content.settings).toEqual({ isFoundingShelfVisible: false });
      expect(namesForUserIds).toHaveBeenCalledTimes(1);
    });

    it('reads a missing settings row as a visible shelf', async () => {
      const content = await service.getContent();
      expect(content.settings).toEqual({ isFoundingShelfVisible: true });
    });

    it('searches personas with an escaped pattern and the contract limit', async () => {
      const result = await service.searchPersonas(' 50%_off ');
      const [searchCall] = statementsOf(query, '"has_card"');
      expect(searchCall?.[1]).toEqual(['%50\\%\\_off%', 20]);
      expect(result.items).toEqual([
        {
          artist: expect.objectContaining({ id: PERSONA_ID }) as unknown,
          isEligible: true,
          hasCard: false,
          isFoundingArtist: false,
        },
      ]);
    });
  });

  describe('createArtistCard', () => {
    it('refuses a card without consent before reading anything', async () => {
      await expect(
        service.createArtistCard(STAFF_ID, {
          subprofileId: PERSONA_ID,
          hasConsent: false,
        }),
      ).rejects.toMatchObject({
        response: { code: 'studio_landing_consent_required' },
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it.each([
      [
        'an ineligible persona',
        { is_eligible: false, has_card: true, card_count: 6 },
        'studio_landing_persona_not_eligible',
      ],
      [
        'a persona with a card',
        { is_eligible: true, has_card: true, card_count: 6 },
        'studio_landing_card_exists',
      ],
      [
        'a seventh card',
        { is_eligible: true, has_card: false, card_count: 6 },
        'studio_landing_cards_full',
      ],
    ])('refuses %s in the contract order', async (_label, state, code) => {
      staged.cardState = state;
      expect(
        await codeOf(
          service.createArtistCard(STAFF_ID, {
            subprofileId: PERSONA_ID,
            hasConsent: true,
          }),
        ),
      ).toBe(code);
      expect(statementsOf(managerQuery, 'INSERT INTO')).toEqual([]);
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('refuses a persona that does not exist as not eligible', async () => {
      managerQuery.mockImplementation(() => Promise.resolve([]));
      expect(
        await codeOf(
          service.createArtistCard(STAFF_ID, {
            subprofileId: PERSONA_ID,
            hasConsent: true,
          }),
        ),
      ).toBe('studio_landing_persona_not_eligible');
    });

    it('locks the table before the checks and the insert', async () => {
      await service.createArtistCard(STAFF_ID, {
        subprofileId: PERSONA_ID,
        hasConsent: true,
      });
      const statements = (managerQuery.mock.calls as [string][]).map(
        ([sql]) => sql,
      );
      expect(statements[0]).toBe(
        'LOCK TABLE "studio_landing_artist_cards" IN SHARE ROW EXCLUSIVE MODE',
      );
      expect(statements[1]).toContain('"card_count"');
      expect(statements[2]).toContain('INSERT INTO');
    });

    it('stores an empty quote as null and stamps consent', async () => {
      await service.createArtistCard(STAFF_ID, {
        subprofileId: PERSONA_ID,
        quote: '   ',
        hasConsent: true,
      });
      const [insertCall] = statementsOf(
        managerQuery,
        'INSERT INTO "studio_landing_artist_cards"',
      );
      expect(insertCall?.[0]).toContain('now()');
      expect(insertCall?.[0]).toContain('MAX("position")');
      expect(insertCall?.[1]).toEqual([PERSONA_ID, null, STAFF_ID]);
    });

    it('trims a quote before storing it', async () => {
      await service.createArtistCard(STAFF_ID, {
        subprofileId: PERSONA_ID,
        quote: '  We sing ',
        hasConsent: true,
      });
      const [insertCall] = statementsOf(managerQuery, 'INSERT INTO');
      expect(insertCall?.[1]).toEqual([PERSONA_ID, 'We sing', STAFF_ID]);
    });

    it('answers the card shape and bumps the memo after the transaction', async () => {
      const card = await service.createArtistCard(STAFF_ID, {
        subprofileId: PERSONA_ID,
        hasConsent: true,
      });
      expect(card.id).toBe(CARD_ID);
      expect(studioLandingMemoGeneration()).toBe(1);
    });

    it('maps a unique violation on the subprofile constraint to the exists code', async () => {
      managerQuery.mockImplementation((sql: string) =>
        sql.startsWith('INSERT INTO')
          ? Promise.reject(
              Object.assign(new Error('duplicate'), {
                code: '23505',
                constraint: 'UQ_studio_landing_artist_cards_subprofile',
              }),
            )
          : Promise.resolve(
              sql.includes('"card_count"') ? [staged.cardState] : [],
            ),
      );
      expect(
        await codeOf(
          service.createArtistCard(STAFF_ID, {
            subprofileId: PERSONA_ID,
            hasConsent: true,
          }),
        ),
      ).toBe('studio_landing_card_exists');
      expect(studioLandingMemoGeneration()).toBe(0);
    });
  });

  describe('updateArtistCard', () => {
    it('restamps consent and rewrites the trimmed quote', async () => {
      await service.updateArtistCard(CARD_ID, {
        quote: '  New words ',
        hasConsent: true,
      });
      const [updateCall] = statementsOf(query, 'WITH "changed"');
      expect(updateCall?.[0]).toContain('"consented_at" = now()');
      expect(updateCall?.[0]).toContain('"updated_at" = now()');
      expect(updateCall?.[1]).toEqual([CARD_ID, 'New words']);
      expect(studioLandingMemoGeneration()).toBe(1);
    });

    it('stores a cleared quote as null', async () => {
      await service.updateArtistCard(CARD_ID, {
        quote: null,
        hasConsent: true,
      });
      await service.updateArtistCard(CARD_ID, {
        quote: '  ',
        hasConsent: true,
      });
      expect(
        statementsOf(query, 'WITH "changed"').map(
          ([, parameters]) => parameters,
        ),
      ).toEqual([
        [CARD_ID, null],
        [CARD_ID, null],
      ]);
    });

    it('refuses an update without consent and writes nothing', async () => {
      expect(
        await codeOf(
          service.updateArtistCard(CARD_ID, {
            quote: 'Words',
            hasConsent: false,
          }),
        ),
      ).toBe('studio_landing_consent_required');
      expect(statementsOf(query, 'WITH "changed"')).toEqual([]);
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('answers studio_landing_card_not_found for an unknown card', async () => {
      staged.existingCardIds = [];
      expect(
        await codeOf(
          service.updateArtistCard(CARD_ID, {
            quote: 'Words',
            hasConsent: false,
          }),
        ),
      ).toBe('studio_landing_card_not_found');
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('answers studio_landing_card_not_found when the card vanished before the write', async () => {
      staged.changedIds = [];
      expect(
        await codeOf(
          service.updateArtistCard(CARD_ID, {
            quote: 'Words',
            hasConsent: true,
          }),
        ),
      ).toBe('studio_landing_card_not_found');
    });
  });

  describe('deleteArtistCard', () => {
    it('deletes a card and bumps the memo', async () => {
      await service.deleteArtistCard(CARD_ID);
      expect(statementsOf(query, 'DELETE FROM')[0]?.[1]).toEqual([CARD_ID]);
      expect(studioLandingMemoGeneration()).toBe(1);
    });

    it('answers studio_landing_card_not_found for an unknown card', async () => {
      staged.changedIds = [];
      expect(await codeOf(service.deleteArtistCard(CARD_ID))).toBe(
        'studio_landing_card_not_found',
      );
      expect(studioLandingMemoGeneration()).toBe(0);
    });
  });

  describe('founding artists', () => {
    it.each([
      [
        'an ineligible persona',
        { is_eligible: false, is_listed: true, listed_count: 50 },
        'studio_founding_persona_not_eligible',
      ],
      [
        'a listed persona',
        { is_eligible: true, is_listed: true, listed_count: 50 },
        'studio_founding_artist_exists',
      ],
      [
        'a fifty-first artist',
        { is_eligible: true, is_listed: false, listed_count: 50 },
        'studio_founding_artists_full',
      ],
    ])('refuses %s as a founding artist', async (_label, state, code) => {
      staged.foundingState = state;
      expect(
        await codeOf(service.addFoundingArtist(STAFF_ID, PERSONA_ID)),
      ).toBe(code);
      expect(statementsOf(managerQuery, 'INSERT INTO')).toEqual([]);
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('locks, inserts at the next position and bumps the memo', async () => {
      const founding = await service.addFoundingArtist(STAFF_ID, PERSONA_ID);
      const statements = (managerQuery.mock.calls as [string][]).map(
        ([sql]) => sql,
      );
      expect(statements[0]).toBe(
        'LOCK TABLE "studio_founding_artists" IN SHARE ROW EXCLUSIVE MODE',
      );
      const [insertCall] = statementsOf(managerQuery, 'INSERT INTO');
      expect(insertCall?.[0]).toContain('MAX("position")');
      expect(insertCall?.[1]).toEqual([PERSONA_ID, STAFF_ID]);
      expect(founding.id).toBe(FOUNDING_ID);
      expect(studioLandingMemoGeneration()).toBe(1);
    });

    it('maps a unique violation on the subprofile constraint to the exists code', async () => {
      managerQuery.mockImplementation((sql: string) =>
        sql.startsWith('INSERT INTO')
          ? Promise.reject(
              Object.assign(new Error('duplicate'), {
                code: '23505',
                constraint: 'UQ_studio_founding_artists_subprofile',
              }),
            )
          : Promise.resolve(
              sql.includes('"listed_count"') ? [staged.foundingState] : [],
            ),
      );
      expect(
        await codeOf(service.addFoundingArtist(STAFF_ID, PERSONA_ID)),
      ).toBe('studio_founding_artist_exists');
    });

    it('removes a founding artist and answers not_found for an unknown one', async () => {
      await service.removeFoundingArtist(FOUNDING_ID);
      expect(studioLandingMemoGeneration()).toBe(1);
      staged.changedIds = [];
      expect(await codeOf(service.removeFoundingArtist(FOUNDING_ID))).toBe(
        'studio_founding_artist_not_found',
      );
      expect(studioLandingMemoGeneration()).toBe(1);
    });
  });

  describe('reorders', () => {
    it('writes positions 1..n over every card and bumps the memo', async () => {
      const cards = await service.reorderArtistCards([SECOND_CARD_ID, CARD_ID]);
      const [reorderCall] = statementsOf(managerQuery, 'unnest');
      expect(reorderCall?.[1]).toEqual([
        [SECOND_CARD_ID, CARD_ID],
        [1, 2],
      ]);
      expect(cards.map((card) => card.id)).toEqual([CARD_ID]);
      expect(studioLandingMemoGeneration()).toBe(1);
    });

    it('writes positions 1..n over every founding artist', async () => {
      staged.currentIds = [FOUNDING_ID, SECOND_FOUNDING_ID];
      const rows = await service.reorderFoundingArtists([
        SECOND_FOUNDING_ID,
        FOUNDING_ID,
      ]);
      const [reorderCall] = statementsOf(managerQuery, 'unnest');
      expect(reorderCall?.[0]).toContain('"studio_founding_artists"');
      expect(reorderCall?.[1]).toEqual([
        [SECOND_FOUNDING_ID, FOUNDING_ID],
        [1, 2],
      ]);
      expect(rows.map((row) => row.id)).toEqual([FOUNDING_ID]);
      expect(studioLandingMemoGeneration()).toBe(1);
    });

    it('answers studio_landing_order_mismatch for a card reorder that skips or repeats a row', async () => {
      expect(await codeOf(service.reorderArtistCards([CARD_ID]))).toBe(
        'studio_landing_order_mismatch',
      );
      expect(await codeOf(service.reorderArtistCards([CARD_ID, CARD_ID]))).toBe(
        'studio_landing_order_mismatch',
      );
      expect(statementsOf(managerQuery, 'unnest')).toEqual([]);
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('answers studio_landing_order_mismatch for a founding reorder that skips a row', async () => {
      staged.currentIds = [FOUNDING_ID, SECOND_FOUNDING_ID];
      expect(await codeOf(service.reorderFoundingArtists([FOUNDING_ID]))).toBe(
        'studio_landing_order_mismatch',
      );
      expect(statementsOf(managerQuery, 'unnest')).toEqual([]);
      expect(studioLandingMemoGeneration()).toBe(0);
    });
  });

  describe('updateSettings', () => {
    it('upserts settings row 1 with the staff id', async () => {
      const settings = await service.updateSettings(STAFF_ID, false);
      const [upsertCall] = statementsOf(query, 'ON CONFLICT');
      expect(upsertCall?.[0]).toContain(
        'INSERT INTO "studio_landing_settings"',
      );
      expect(upsertCall?.[0]).toContain('ON CONFLICT ("id") DO UPDATE');
      expect(upsertCall?.[0]).toContain('VALUES (1,');
      expect(upsertCall?.[1]).toEqual([false, STAFF_ID]);
      expect(settings).toEqual({ isFoundingShelfVisible: false });
      expect(studioLandingMemoGeneration()).toBe(1);
    });
  });

  it('bumps the memo once after every write', async () => {
    await service.createArtistCard(STAFF_ID, {
      subprofileId: PERSONA_ID,
      hasConsent: true,
    });
    await service.updateArtistCard(CARD_ID, { quote: null, hasConsent: true });
    await service.deleteArtistCard(CARD_ID);
    await service.reorderArtistCards([CARD_ID, SECOND_CARD_ID]);
    await service.addFoundingArtist(STAFF_ID, PERSONA_ID);
    staged.currentIds = [FOUNDING_ID];
    await service.reorderFoundingArtists([FOUNDING_ID]);
    await service.removeFoundingArtist(FOUNDING_ID);
    await service.updateSettings(STAFF_ID, true);
    expect(studioLandingMemoGeneration()).toBe(8);
  });
});
