import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PRIVATE_PARAMETERS_COMMENT } from '../database/private-parameters-logger';
import {
  isStudioAudioKey,
  studioAudioContentTypeForKey,
} from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import {
  openBrowsableEventSql,
  openUpcomingEventSql,
} from './studio-discovery-sql';
import {
  STUDIO_LANDING_MEMO_MILLISECONDS,
  invalidateStudioLandingMemo,
  studioLandingMemoGeneration,
} from './studio-landing-memo';
import {
  LandingArtistCardRow,
  LandingNextEventRow,
  LandingPhotoRow,
  LandingPreviewRow,
  StudioLandingPreviewStream,
  StudioLandingResponse,
  landingPersonaColumnsSql,
  toStudioLandingArtistCard,
  toStudioLandingCounts,
  toStudioLandingNextEvent,
  toStudioLandingPhoto,
  toStudioLandingPreviewCard,
} from './studio-landing-response';
import {
  STUDIO_LANDING_EVENT_TIME_ZONE,
  landingArtistPersonaSql,
  landingLiveArtistSql,
  landingPreviewEligibleSql,
} from './studio-landing-sql';
import { standingPerformanceAffiliationSql } from './studio-scenes.service';
import { STUDIO_LIMITS, studioError } from './studio.constants';

/**
 * Heads every public landing read, so a failed or slow query logs its SQL
 * text with its bound values left out (`PrivateParametersLogger`).
 */
export const LANDING_PRIVATE_PARAMETERS_MARKER = `/* ${PRIVATE_PARAMETERS_COMMENT} */`;

/**
 * Contract 2.1, one row. `$1` the time zone of the month window
 * (`STUDIO_LANDING_EVENT_TIME_ZONE`): `events_this_month` counts `start_at`
 * from local midnight on the 1st up to local midnight on the 1st of next
 * month, both ends converted from local time, so a DST change cannot move
 * the end. Past events of the month count, and so do members events: only a
 * number leaves the server.
 */
export const LANDING_COUNTS_SQL = `${LANDING_PRIVATE_PARAMETERS_MARKER} SELECT
  (SELECT COUNT(*)::int FROM "subprofiles" "persona"
    WHERE ${landingLiveArtistSql('persona')}) AS "artists",
  (SELECT COUNT(*)::int FROM "studio_releases" "release"
     INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
    WHERE "release"."status" = 'published'
      AND ${landingLiveArtistSql('persona')}) AS "releases",
  (SELECT COUNT(DISTINCT "event"."id")::int FROM "events" "event"
    WHERE ${openBrowsableEventSql('event')}
      AND "event"."start_at" >= (date_trunc('month', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text)
      AND "event"."start_at" < ((date_trunc('month', now() AT TIME ZONE $1::text) + interval '1 month') AT TIME ZONE $1::text)
      AND EXISTS (
        SELECT 1 FROM "subprofile_affiliations" "affiliation"
         INNER JOIN "subprofiles" "persona" ON "persona"."id" = "affiliation"."subprofile_id"
         WHERE "affiliation"."target_type" = 'event'
           AND "affiliation"."target_slug" = "event"."slug"
           AND ${standingPerformanceAffiliationSql('affiliation', 'event', 'landing_count')}
           AND ${landingLiveArtistSql('persona')}
      )) AS "events_this_month"`;

/**
 * Contract 2.1 `nextEvent`, at most one row: the earliest public upcoming
 * event with a standing performer who passes `landingLiveArtistSql` and is
 * linked: an unlinked persona stays off the card, since the event's host or
 * lineup would tie its stage name to the member. Area level only: no venue,
 * address, host, cover or attendee column is read.
 */
export const LANDING_NEXT_EVENT_SQL = `${LANDING_PRIVATE_PARAMETERS_MARKER} SELECT
       "event"."slug" AS "slug",
       "event"."title" AS "title",
       "event"."start_at" AS "start_at",
       "event"."timezone" AS "timezone",
       "event"."neighbourhood" AS "neighbourhood",
       "event"."is_online" AS "is_online",
       ${landingPersonaColumnsSql('persona', 'artist')}
  FROM "events" "event"
  INNER JOIN "subprofile_affiliations" "affiliation"
          ON "affiliation"."target_type" = 'event'
         AND "affiliation"."target_slug" = "event"."slug"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "affiliation"."subprofile_id"
 WHERE ${openUpcomingEventSql('event')}
   AND "event"."visibility" = 'public'
   AND ${standingPerformanceAffiliationSql('affiliation', 'event', 'landing_next')}
   AND ${landingLiveArtistSql('persona')}
   AND "persona"."link_visibility" = 'linked'
 ORDER BY "event"."start_at" ASC, "event"."id" ASC,
          "persona"."display_name" ASC, "persona"."id" ASC
 LIMIT 1`;

/** The preview, its track, release and release persona, under the aliases
 *  `preview`, `track`, `release` and `persona`, kept to approved rows whose
 *  track passes every contract 1.2 rule right now. */
const ELIGIBLE_APPROVED_PREVIEWS_FROM_SQL = `FROM "studio_landing_previews" "preview"
  INNER JOIN "studio_tracks" "track" ON "track"."id" = "preview"."track_id"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "preview"."status" = 'approved'
   AND ${landingPreviewEligibleSql('track', 'release', 'persona')}`;

/** Contract 2.1 `previews`. `$1` the limit (`STUDIO_LIMITS.landingPreviewsShown`). */
export const LANDING_PREVIEWS_SQL = `${LANDING_PRIVATE_PARAMETERS_MARKER} SELECT
       "preview"."id" AS "id",
       "track"."title" AS "track_title",
       "track"."duration_seconds" AS "duration_seconds",
       "release"."cover_key" AS "cover_key",
       ${landingPersonaColumnsSql('persona', 'artist')}
  ${ELIGIBLE_APPROVED_PREVIEWS_FROM_SQL}
 ORDER BY "preview"."position" ASC, "preview"."id" ASC
 LIMIT $1`;

/**
 * Contract 2.1 `artists`. `$1` the limit (`STUDIO_LIMITS.landingArtistCardsMax`).
 * Founding artists first, then staff order; a founding artist without a card
 * never appears here.
 */
export const LANDING_ARTIST_CARDS_SQL = `${LANDING_PRIVATE_PARAMETERS_MARKER} SELECT
       "card"."id" AS "id",
       "card"."quote" AS "quote",
       ("founding"."id" IS NOT NULL) AS "is_founding_artist",
       ${landingPersonaColumnsSql('persona', 'artist')}
  FROM "studio_landing_artist_cards" "card"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "card"."subprofile_id"
  LEFT JOIN "studio_founding_artists" "founding"
         ON "founding"."subprofile_id" = "card"."subprofile_id"
 WHERE "card"."has_consent"
   AND ${landingArtistPersonaSql('persona')}
 ORDER BY "is_founding_artist" DESC, "card"."position" ASC, "card"."id" ASC
 LIMIT $1`;

/** Contract 2.1 `photos`: the stored slots, each at most once. */
export const LANDING_PHOTOS_SQL = `${LANDING_PRIVATE_PARAMETERS_MARKER} SELECT
       "photo"."slot"::text AS "slot",
       "photo"."image_key" AS "image_key",
       "photo"."alt_text_en" AS "alt_text_en",
       "photo"."alt_text_pt" AS "alt_text_pt",
       "photo"."credit" AS "credit"
  FROM "studio_landing_photos" "photo"
 WHERE "photo"."has_consent"
 ORDER BY "photo"."slot" ASC`;

/** Contract 3: the audio of one approved, eligible preview. `$1` the preview id. */
export const LANDING_PREVIEW_STREAM_SQL = `${LANDING_PRIVATE_PARAMETERS_MARKER} SELECT
       "track"."audio_key" AS "audio_key",
       "track"."audio_content_type" AS "audio_content_type",
       "track"."duration_seconds" AS "duration_seconds"
  ${ELIGIBLE_APPROVED_PREVIEWS_FROM_SQL}
   AND "preview"."id" = $1::uuid
 LIMIT 1`;

type LandingCountsRow = {
  artists: number | string;
  releases: number | string;
  events_this_month: number | string;
};

type LandingPhotoSlotRow = LandingPhotoRow & { slot: string };

type LandingPreviewStreamRow = {
  audio_key: string | null;
  audio_content_type: string | null;
  duration_seconds: number | null;
};

interface LandingMemo {
  payload: StudioLandingResponse;
  storedAtMilliseconds: number;
  generation: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The public Studio page (contract 2) and its preview stream (contract 3).
 *
 * `getPublicLanding` keeps one built payload for
 * `STUDIO_LANDING_MEMO_MILLISECONDS`, tagged with the memo generation it read
 * before its first query; a read serves it while it is fresh and the
 * generation still matches, so a write (`invalidateStudioLandingMemo`) drops
 * it at once and a build that started before that write never serves as
 * current. The memo is per process, like the `ThrottlerModule` storage
 * (SINGLE-REPLICA ONLY). Read-time rules (eligibility, persona status, the
 * creator's account, claims) apply on every rebuild, so a track that gains a
 * content warning or a claim drops out at the next rebuild with no write.
 *
 * `getPreviewStream` records nothing and logs nothing: no play row, no
 * listen row, no milestone, no log line naming the preview or the track.
 * This class holds no logger on purpose.
 */
@Injectable()
export class StudioLandingReadService {
  private memo: LandingMemo | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  async getPublicLanding(): Promise<StudioLandingResponse> {
    const startedAtMilliseconds = Date.now();
    const generation = studioLandingMemoGeneration();
    const memo = this.memo;
    if (
      memo &&
      memo.generation === generation &&
      startedAtMilliseconds - memo.storedAtMilliseconds <
        STUDIO_LANDING_MEMO_MILLISECONDS
    ) {
      return memo.payload;
    }
    const payload = await this.buildPayload();
    // A write that landed while this build ran bumped the generation: keep
    // the build out of the memo so the next read starts afresh.
    if (generation === studioLandingMemoGeneration()) {
      this.memo = {
        payload,
        storedAtMilliseconds: startedAtMilliseconds,
        generation,
      };
    }
    return payload;
  }

  async getPreviewStream(
    previewId: string,
  ): Promise<StudioLandingPreviewStream> {
    if (!UUID_PATTERN.test(previewId)) {
      throw studioError('studio_landing_preview_unavailable');
    }
    const rows: LandingPreviewStreamRow[] = await this.dataSource.query(
      LANDING_PREVIEW_STREAM_SQL,
      [previewId.toLowerCase()],
    );
    const row = rows[0];
    const audioKey = row?.audio_key ?? null;
    // `createPresignedAudioStream` signs a Studio audio key only; any other
    // key answers the preview's own 404 here.
    if (!row || !audioKey || !isStudioAudioKey(audioKey)) {
      throw studioError('studio_landing_preview_unavailable');
    }
    const contentType =
      row.audio_content_type ?? studioAudioContentTypeForKey(audioKey);
    if (!contentType) {
      throw studioError('studio_landing_preview_unavailable');
    }
    const signedStream = await this.storage.createPresignedAudioStream(
      audioKey,
      contentType,
      row.duration_seconds,
    );
    return { url: signedStream.url, expiresAt: signedStream.expiresAt };
  }

  /** Drops the memo of every service in this process. */
  invalidate(): void {
    invalidateStudioLandingMemo();
  }

  private async buildPayload(): Promise<StudioLandingResponse> {
    const countsRead: Promise<LandingCountsRow[]> = this.dataSource.query(
      LANDING_COUNTS_SQL,
      [STUDIO_LANDING_EVENT_TIME_ZONE],
    );
    const nextEventRead: Promise<LandingNextEventRow[]> = this.dataSource.query(
      LANDING_NEXT_EVENT_SQL,
    );
    const previewsRead: Promise<LandingPreviewRow[]> = this.dataSource.query(
      LANDING_PREVIEWS_SQL,
      [STUDIO_LIMITS.landingPreviewsShown],
    );
    const cardsRead: Promise<LandingArtistCardRow[]> = this.dataSource.query(
      LANDING_ARTIST_CARDS_SQL,
      [STUDIO_LIMITS.landingArtistCardsMax],
    );
    const photosRead: Promise<LandingPhotoSlotRow[]> =
      this.dataSource.query(LANDING_PHOTOS_SQL);
    const [countRows, nextEventRows, previewRows, cardRows, photoRows] =
      await Promise.all([
        countsRead,
        nextEventRead,
        previewsRead,
        cardsRead,
        photosRead,
      ]);
    const countRow = countRows[0] ?? {
      artists: 0,
      releases: 0,
      events_this_month: 0,
    };
    const nextEventRow = nextEventRows[0];
    const photoOf = (slot: string) => {
      const photoRow = photoRows.find((candidate) => candidate.slot === slot);
      return photoRow ? toStudioLandingPhoto(photoRow) : null;
    };
    return {
      counts: toStudioLandingCounts(countRow),
      nextEvent: nextEventRow ? toStudioLandingNextEvent(nextEventRow) : null,
      previews: previewRows.map((row) => toStudioLandingPreviewCard(row)),
      artists: cardRows.map((row) => toStudioLandingArtistCard(row)),
      photos: { hero: photoOf('hero'), manifesto: photoOf('manifesto') },
    };
  }
}
