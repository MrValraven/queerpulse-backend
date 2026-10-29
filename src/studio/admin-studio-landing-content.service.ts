import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { ModAuditService } from '../moderation/mod-audit.service';
import { foldedHaystack, foldedTextExpression } from '../search/search-text';
import { listsEveryIdOnce } from './admin-studio-curation.service';
import {
  AdminFoundingArtistRow,
  AdminLandingArtistCardRow,
  AdminLandingPersonaOptionRow,
  AdminStudioFoundingArtist,
  AdminStudioLandingArtistCard,
  AdminStudioLandingContent,
  AdminStudioLandingPersonaOption,
  AdminStudioLandingSettings,
  toAdminStudioFoundingArtist,
  toAdminStudioLandingArtistCard,
  toAdminStudioLandingPersonaOption,
} from './admin-studio-landing-response';
import {
  CreateStudioLandingArtistCardDto,
  UpdateStudioLandingArtistCardDto,
} from './dto/admin-studio-landing.dto';
import {
  personaColumnsSql,
  STUDIO_ARTIST_KIND_LIST_SQL,
} from './studio-discovery-sql';
import { invalidateStudioLandingMemo } from './studio-landing-memo';
import { landingArtistPersonaSql } from './studio-landing-sql';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_DISCOVERY_LIMITS,
  STUDIO_LIMITS,
  studioError,
} from './studio.constants';

const CARD_SUBPROFILE_CONSTRAINT = 'UQ_studio_landing_artist_cards_subprofile';
const FOUNDING_SUBPROFILE_CONSTRAINT = 'UQ_studio_founding_artists_subprofile';

/** Cards and founding rows take this first, so the cap check and the next
 *  position are decided one write at a time. Staff-only and tiny. */
const LOCK_CARDS_SQL =
  'LOCK TABLE "studio_landing_artist_cards" IN SHARE ROW EXCLUSIVE MODE';
const LOCK_FOUNDING_SQL =
  'LOCK TABLE "studio_founding_artists" IN SHARE ROW EXCLUSIVE MODE';

/** `$1` a persona id. At most one row; no row means the persona does not
 *  exist, which reads as not eligible. */
const CARD_CREATE_STATE_SQL = `SELECT ${landingArtistPersonaSql('persona')} AS "is_eligible",
       EXISTS (SELECT 1 FROM "studio_landing_artist_cards" "existing_card"
                WHERE "existing_card"."subprofile_id" = "persona"."id") AS "has_card",
       (SELECT CAST(COUNT(*) AS int) FROM "studio_landing_artist_cards") AS "card_count"
  FROM "subprofiles" "persona"
 WHERE "persona"."id" = $1::uuid`;

const FOUNDING_CREATE_STATE_SQL = `SELECT ${landingArtistPersonaSql('persona')} AS "is_eligible",
       EXISTS (SELECT 1 FROM "studio_founding_artists" "existing_founding"
                WHERE "existing_founding"."subprofile_id" = "persona"."id") AS "is_listed",
       (SELECT CAST(COUNT(*) AS int) FROM "studio_founding_artists") AS "listed_count"
  FROM "subprofiles" "persona"
 WHERE "persona"."id" = $1::uuid`;

/** `$1` persona, `$2` quote or null, `$3` staff. The quote is stored as sent
 *  after trimming, consent is stamped now, and the position is the next free one. */
const INSERT_CARD_SQL = `INSERT INTO "studio_landing_artist_cards"
  ("subprofile_id", "quote", "position", "has_consent", "consented_at", "created_by_id")
  VALUES ($1::uuid, $2::text,
          COALESCE((SELECT MAX("position") FROM "studio_landing_artist_cards"), 0) + 1,
          true, now(), $3::uuid)
  RETURNING "id"`;

/** `$1` persona, `$2` staff. */
const INSERT_FOUNDING_SQL = `INSERT INTO "studio_founding_artists"
  ("subprofile_id", "position", "added_by_id")
  VALUES ($1::uuid,
          COALESCE((SELECT MAX("position") FROM "studio_founding_artists"), 0) + 1,
          $2::uuid)
  RETURNING "id"`;

const CARD_EXISTS_SQL = `SELECT "id" FROM "studio_landing_artist_cards" WHERE "id" = $1::uuid`;

/** `$1` card, `$2` quote or null. Every save restamps consent. The data-modifying
 *  CTE returns the written row through `DataSource.query`, which hands back
 *  only the affected count for a bare UPDATE ... RETURNING. */
const UPDATE_CARD_SQL = `WITH "changed" AS (
  UPDATE "studio_landing_artist_cards"
     SET "quote" = $2::text, "has_consent" = true, "consented_at" = now(), "updated_at" = now()
   WHERE "id" = $1::uuid
  RETURNING "id"
)
SELECT "id" FROM "changed"`;

const DELETE_CARD_SQL = `WITH "removed" AS (
  DELETE FROM "studio_landing_artist_cards" WHERE "id" = $1::uuid RETURNING "id"
)
SELECT "id" FROM "removed"`;

const DELETE_FOUNDING_SQL = `WITH "removed" AS (
  DELETE FROM "studio_founding_artists" WHERE "id" = $1::uuid RETURNING "id"
)
SELECT "id" FROM "removed"`;

const CARD_IDS_SQL = 'SELECT "id" FROM "studio_landing_artist_cards"';
const FOUNDING_IDS_SQL = 'SELECT "id" FROM "studio_founding_artists"';

const REORDER_CARDS_SQL = `UPDATE "studio_landing_artist_cards" AS "card" SET "position" = "ordering"."position"
  FROM unnest($1::uuid[], $2::smallint[]) AS "ordering"("card_id", "position")
 WHERE "card"."id" = "ordering"."card_id"`;

const REORDER_FOUNDING_SQL = `UPDATE "studio_founding_artists" AS "founding" SET "position" = "ordering"."position"
  FROM unnest($1::uuid[], $2::smallint[]) AS "ordering"("founding_id", "position")
 WHERE "founding"."id" = "ordering"."founding_id"`;

/** `$1` a card id or null. `is_shown` is the rule the public landing applies
 *  to the persona now; `is_founding_artist` reads the founding list. */
const ADMIN_CARDS_SQL = `SELECT "card"."id" AS "id",
       "card"."quote" AS "quote",
       "card"."position" AS "position",
       "card"."consented_at" AS "consented_at",
       "card"."created_by_id" AS "created_by_id",
       ${landingArtistPersonaSql('persona')} AS "is_shown",
       ("founding"."id" IS NOT NULL) AS "is_founding_artist",
       ${personaColumnsSql('persona', 'artist')}
  FROM "studio_landing_artist_cards" "card"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "card"."subprofile_id"
  LEFT JOIN "studio_founding_artists" "founding" ON "founding"."subprofile_id" = "persona"."id"
 WHERE ($1::uuid IS NULL OR "card"."id" = $1::uuid)
 ORDER BY "card"."position" ASC, "card"."id" ASC`;

/** `$1` a founding row id or null. */
const ADMIN_FOUNDING_SQL = `SELECT "founding"."id" AS "id",
       "founding"."position" AS "position",
       "founding"."added_by_id" AS "added_by_id",
       "founding"."created_at" AS "created_at",
       ${landingArtistPersonaSql('persona')} AS "is_listed",
       ${personaColumnsSql('persona', 'artist')}
  FROM "studio_founding_artists" "founding"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "founding"."subprofile_id"
 WHERE ($1::uuid IS NULL OR "founding"."id" = $1::uuid)
 ORDER BY "founding"."position" ASC, "founding"."id" ASC`;

const SETTINGS_SQL = `SELECT "is_founding_shelf_visible" FROM "studio_landing_settings" WHERE "id" = 1`;

const UPSERT_SETTINGS_SQL = `INSERT INTO "studio_landing_settings" ("id", "is_founding_shelf_visible", "updated_by_id", "updated_at")
  VALUES (1, $1::boolean, $2::uuid, now())
  ON CONFLICT ("id") DO UPDATE
    SET "is_founding_shelf_visible" = EXCLUDED."is_founding_shelf_visible",
        "updated_by_id" = EXCLUDED."updated_by_id",
        "updated_at" = now()`;

/** `$1` the LIKE pattern, `$2` the limit. Personas of an artist kind that
 *  pass `listenablePersonaSql`, by folded display name or handle. */
const ADMIN_PERSONA_SEARCH_SQL = `SELECT ${personaColumnsSql('persona', 'artist')},
       ${landingArtistPersonaSql('persona')} AS "is_eligible",
       EXISTS (SELECT 1 FROM "studio_landing_artist_cards" "search_card"
                WHERE "search_card"."subprofile_id" = "persona"."id") AS "has_card",
       EXISTS (SELECT 1 FROM "studio_founding_artists" "search_founding"
                WHERE "search_founding"."subprofile_id" = "persona"."id") AS "is_founding_artist"
  FROM "subprofiles" "persona"
 WHERE "persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
   AND ${listenablePersonaSql('persona')}
   AND ${foldedHaystack('persona', ['display_name', 'handle'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\'
 ORDER BY "persona"."display_name" ASC, "persona"."id" ASC
 LIMIT $2`;

interface CardCreateStateRow {
  is_eligible: boolean;
  has_card: boolean;
  card_count: number;
}

interface FoundingCreateStateRow {
  is_eligible: boolean;
  is_listed: boolean;
  listed_count: number;
}

/** Trimmed; an empty quote is stored as null. */
export function normalizeLandingQuote(
  quote: string | null | undefined,
): string | null {
  const trimmedQuote = quote?.trim();
  return trimmedQuote ? trimmedQuote : null;
}

/**
 * Studio landing v2 (contract 9.4 and 9.6): the staff side of the artist
 * cards, the founding artists list and the shelf switch.
 *
 * A card or founding insert runs in one transaction that locks its table
 * first, so the cap check and the next position are decided one write at a
 * time. Checks run in contract order and the consent tick comes first, before
 * any read. Consent is re-confirmed on every save: an update restamps
 * `consented_at` for the quote as saved. The founding badge on artist pages
 * stays independent of the shelf switch, which only hides the shelf on the
 * public landing.
 *
 * Every write calls `invalidateStudioLandingMemo()` after it resolves, so the
 * next public read rebuilds.
 */
@Injectable()
export class AdminStudioLandingContentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly modAudit: ModAuditService,
  ) {}

  async getContent(): Promise<AdminStudioLandingContent> {
    const [cardRows, foundingRows, settingsRows] = await Promise.all([
      this.readCardRows(null),
      this.readFoundingRows(null),
      this.readSettingsRows(),
    ]);
    const staffNames = await this.modAudit.namesForUserIds([
      ...cardRows.flatMap((row) =>
        row.created_by_id ? [row.created_by_id] : [],
      ),
      ...foundingRows.flatMap((row) =>
        row.added_by_id ? [row.added_by_id] : [],
      ),
    ]);
    return {
      artistCards: cardRows.map((row) =>
        toAdminStudioLandingArtistCard(row, staffNames),
      ),
      foundingArtists: foundingRows.map((row) =>
        toAdminStudioFoundingArtist(row, staffNames),
      ),
      settings: {
        isFoundingShelfVisible:
          settingsRows[0]?.is_founding_shelf_visible ?? true,
      },
    };
  }

  async searchPersonas(
    query: string,
  ): Promise<{ items: AdminStudioLandingPersonaOption[] }> {
    const rows: AdminLandingPersonaOptionRow[] = await this.dataSource.query(
      ADMIN_PERSONA_SEARCH_SQL,
      [
        `%${escapeLikeTerm(query.trim())}%`,
        STUDIO_DISCOVERY_LIMITS.adminSearchResults,
      ],
    );
    return { items: rows.map(toAdminStudioLandingPersonaOption) };
  }

  async createArtistCard(
    staffUserId: string,
    body: CreateStudioLandingArtistCardDto,
  ): Promise<AdminStudioLandingArtistCard> {
    if (body.hasConsent !== true) {
      throw studioError('studio_landing_consent_required');
    }
    const quote = normalizeLandingQuote(body.quote);
    let cardId: string;
    try {
      cardId = await this.dataSource.transaction(async (manager) => {
        await manager.query(LOCK_CARDS_SQL);
        const [state]: CardCreateStateRow[] = await manager.query(
          CARD_CREATE_STATE_SQL,
          [body.subprofileId],
        );
        if (!state?.is_eligible) {
          throw studioError('studio_landing_persona_not_eligible');
        }
        if (state.has_card) {
          throw studioError('studio_landing_card_exists');
        }
        if (state.card_count >= STUDIO_LIMITS.landingArtistCardsMax) {
          throw studioError('studio_landing_cards_full');
        }
        const [inserted]: { id: string }[] = await manager.query(
          INSERT_CARD_SQL,
          [body.subprofileId, quote, staffUserId],
        );
        if (!inserted) {
          throw new Error('The artist card insert returned no row.');
        }
        return inserted.id;
      });
    } catch (error) {
      if (isUniqueViolation(error, CARD_SUBPROFILE_CONSTRAINT)) {
        throw studioError('studio_landing_card_exists');
      }
      throw error;
    }
    invalidateStudioLandingMemo();
    return this.loadCardOrThrow(cardId);
  }

  async updateArtistCard(
    cardId: string,
    body: UpdateStudioLandingArtistCardDto,
  ): Promise<AdminStudioLandingArtistCard> {
    const existing: { id: string }[] = await this.dataSource.query(
      CARD_EXISTS_SQL,
      [cardId],
    );
    if (!existing.length) {
      throw studioError('studio_landing_card_not_found');
    }
    if (body.hasConsent !== true) {
      throw studioError('studio_landing_consent_required');
    }
    const changed: { id: string }[] = await this.dataSource.query(
      UPDATE_CARD_SQL,
      [cardId, normalizeLandingQuote(body.quote)],
    );
    if (!changed.length) {
      throw studioError('studio_landing_card_not_found');
    }
    invalidateStudioLandingMemo();
    return this.loadCardOrThrow(cardId);
  }

  async deleteArtistCard(cardId: string): Promise<void> {
    const removed: { id: string }[] = await this.dataSource.query(
      DELETE_CARD_SQL,
      [cardId],
    );
    if (!removed.length) {
      throw studioError('studio_landing_card_not_found');
    }
    invalidateStudioLandingMemo();
  }

  async reorderArtistCards(
    cardIds: string[],
  ): Promise<AdminStudioLandingArtistCard[]> {
    await this.reorderRows(
      LOCK_CARDS_SQL,
      CARD_IDS_SQL,
      REORDER_CARDS_SQL,
      cardIds,
    );
    invalidateStudioLandingMemo();
    const cardRows = await this.readCardRows(null);
    const staffNames = await this.modAudit.namesForUserIds(
      cardRows.flatMap((row) => (row.created_by_id ? [row.created_by_id] : [])),
    );
    return cardRows.map((row) =>
      toAdminStudioLandingArtistCard(row, staffNames),
    );
  }

  async addFoundingArtist(
    staffUserId: string,
    subprofileId: string,
  ): Promise<AdminStudioFoundingArtist> {
    let foundingArtistId: string;
    try {
      foundingArtistId = await this.dataSource.transaction(async (manager) => {
        await manager.query(LOCK_FOUNDING_SQL);
        const [state]: FoundingCreateStateRow[] = await manager.query(
          FOUNDING_CREATE_STATE_SQL,
          [subprofileId],
        );
        if (!state?.is_eligible) {
          throw studioError('studio_founding_persona_not_eligible');
        }
        if (state.is_listed) {
          throw studioError('studio_founding_artist_exists');
        }
        if (state.listed_count >= STUDIO_LIMITS.foundingArtistsMax) {
          throw studioError('studio_founding_artists_full');
        }
        const [inserted]: { id: string }[] = await manager.query(
          INSERT_FOUNDING_SQL,
          [subprofileId, staffUserId],
        );
        if (!inserted) {
          throw new Error('The founding artist insert returned no row.');
        }
        return inserted.id;
      });
    } catch (error) {
      if (isUniqueViolation(error, FOUNDING_SUBPROFILE_CONSTRAINT)) {
        throw studioError('studio_founding_artist_exists');
      }
      throw error;
    }
    invalidateStudioLandingMemo();
    return this.loadFoundingArtistOrThrow(foundingArtistId);
  }

  async removeFoundingArtist(foundingArtistId: string): Promise<void> {
    const removed: { id: string }[] = await this.dataSource.query(
      DELETE_FOUNDING_SQL,
      [foundingArtistId],
    );
    if (!removed.length) {
      throw studioError('studio_founding_artist_not_found');
    }
    invalidateStudioLandingMemo();
  }

  async reorderFoundingArtists(
    foundingArtistIds: string[],
  ): Promise<AdminStudioFoundingArtist[]> {
    await this.reorderRows(
      LOCK_FOUNDING_SQL,
      FOUNDING_IDS_SQL,
      REORDER_FOUNDING_SQL,
      foundingArtistIds,
    );
    invalidateStudioLandingMemo();
    const foundingRows = await this.readFoundingRows(null);
    const staffNames = await this.modAudit.namesForUserIds(
      foundingRows.flatMap((row) => (row.added_by_id ? [row.added_by_id] : [])),
    );
    return foundingRows.map((row) =>
      toAdminStudioFoundingArtist(row, staffNames),
    );
  }

  /** Upserts the one settings row and stamps the staff member. */
  async updateSettings(
    staffUserId: string,
    isFoundingShelfVisible: boolean,
  ): Promise<AdminStudioLandingSettings> {
    await this.dataSource.query(UPSERT_SETTINGS_SQL, [
      isFoundingShelfVisible,
      staffUserId,
    ]);
    invalidateStudioLandingMemo();
    return { isFoundingShelfVisible };
  }

  /** Locks the table, checks that `orderedIds` names every row once, then
   *  writes positions 1..n in one statement. */
  private async reorderRows(
    lockSql: string,
    idsSql: string,
    reorderSql: string,
    orderedIds: string[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(lockSql);
      const currentRows: { id: string }[] = await manager.query(idsSql);
      if (
        !listsEveryIdOnce(
          currentRows.map((row) => row.id),
          orderedIds,
        )
      ) {
        throw studioError('studio_landing_order_mismatch');
      }
      const lowerCasedIds = orderedIds.map((rowId) => rowId.toLowerCase());
      await manager.query(reorderSql, [
        lowerCasedIds,
        lowerCasedIds.map((_rowId, index) => index + 1),
      ]);
    });
  }

  private readSettingsRows(): Promise<
    { is_founding_shelf_visible: boolean }[]
  > {
    return this.dataSource.query(SETTINGS_SQL);
  }

  private readCardRows(
    cardId: string | null,
  ): Promise<AdminLandingArtistCardRow[]> {
    return this.dataSource.query(ADMIN_CARDS_SQL, [cardId]);
  }

  private readFoundingRows(
    foundingArtistId: string | null,
  ): Promise<AdminFoundingArtistRow[]> {
    return this.dataSource.query(ADMIN_FOUNDING_SQL, [foundingArtistId]);
  }

  private async loadCardOrThrow(
    cardId: string,
  ): Promise<AdminStudioLandingArtistCard> {
    const [row] = await this.readCardRows(cardId);
    if (!row) {
      throw studioError('studio_landing_card_not_found');
    }
    const staffNames = await this.modAudit.namesForUserIds(
      row.created_by_id ? [row.created_by_id] : [],
    );
    return toAdminStudioLandingArtistCard(row, staffNames);
  }

  private async loadFoundingArtistOrThrow(
    foundingArtistId: string,
  ): Promise<AdminStudioFoundingArtist> {
    const [row] = await this.readFoundingRows(foundingArtistId);
    if (!row) {
      throw studioError('studio_founding_artist_not_found');
    }
    const staffNames = await this.modAudit.namesForUserIds(
      row.added_by_id ? [row.added_by_id] : [],
    );
    return toAdminStudioFoundingArtist(row, staffNames);
  }
}
