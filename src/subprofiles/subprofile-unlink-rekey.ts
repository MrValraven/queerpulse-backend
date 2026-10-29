import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { ReportSubjectType } from '../reports/entities/report.entity';
import { releasePlaylistCreditsOfPersona } from '../studio/studio-playlist-credit-release';
import { forgetTeamLinksOfPersona } from '../listings/listing-team-unlink';
import { forgetDiscoveryTiesOfPersona } from '../studio/studio-discovery-unlink';
import { forgetLandingTiesOfPersona } from '../studio/studio-landing-unlink';
import { forgetListeningOfPersona } from '../studio/studio-listening-unlink';
import {
  forgetSalesOfPersona,
  StudioSalesUnlinkOutcome,
} from '../studio/studio-purchases-unlink';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from './subprofile-takedown';

/**
 * ENG-447: the fresh ids a persona and its items answer under once it goes
 * unlinked.
 *
 * Every public read, route and payload addresses a persona by its row id, so
 * an id someone saw on the named persona would lead straight to the
 * pseudonymous one. Re-keying the row in the unlink transaction retires that
 * id everywhere at once: no row holds it afterwards, so every `:id` route,
 * DTO and socket payload resolves only the new one, and a link built on the
 * old id finds nothing.
 *
 * The primary-key update cascades through every foreign key to
 * `subprofiles.id` (migration `1830060000000-CascadePersonaIdUpdates`):
 * items, social links, affiliations, co-owners, revoked invites, feeds and
 * feed entries, and the handle registry and its history, so the persona's
 * own content and roster follow it. Followers, endorsements, old nested
 * addresses and the messaging identity are deleted, and pending invites
 * revoked, before this runs (`cutTiesToNamedPersona`), so none of them
 * follows.
 *
 * The items get fresh ids too, since every public persona read lists them by
 * id. Their `created_at` restarts at the unlink: the public item view shows
 * it as the item's first-published date (the rights footer reads it), and
 * the named persona's exact timestamps would match its items to these. The
 * item revisions and published feed entries follow through their foreign
 * keys to `subprofile_items.id`, which cascade on update as well. Nothing
 * else stores an item id.
 *
 * Studio v1 releases and tracks get fresh ids for the same reason: the
 * Studio pages, saved cards and stream routes address them by id. Each
 * release's `created_at` restarts and a set `published_at` moves to the
 * unlink, since the named persona's exact publish times would match its
 * releases to these. Open reports on a release move with it, so a takedown
 * decided on one still lands. Tracks follow their release through
 * `FK_studio_tracks_release` (on update cascade) and then get fresh ids of
 * their own. Studio artist kinds: an episode's publish time and alert claim
 * move to the unlink too, and a draft episode stays a draft. Covers are
 * re-homed by `rehomeUnlinkedPersona`; audio keys are random and registered
 * to the persona, whose id the registry follows.
 *
 * Studio v2 playlists credited to the persona turn private and lose the
 * credit, and an entry of anyone's playlist that held one of its tracks keeps
 * a null track (`FK_studio_playlist_tracks_track` sets null on update), so
 * neither ties the pseudonymous persona to its named past.
 *
 * Studio discovery persona credits the persona gave or received, staff
 * picks of its releases, and its Artist of the month and New stars places are
 * deleted before the releases move (`forgetDiscoveryTiesOfPersona`), so no
 * credit, shelf spot or spotlight carries the named persona over.
 *
 * Studio v3: preview links and the track change stamp are cleared on the
 * releases, the reminders set on them are deleted, a scheduled release goes
 * back to draft (its exact drop time would match the two personas, so
 * `publish_at` clears, and a release date the schedule filled clears with
 * it, as a takedown does), version note dates restart, the press kit forgets its chosen tracks (their ids changed), and
 * persona posts get fresh ids with restarted dates, their open reports
 * moving along. The post quota ledger goes too. The milestones the persona reached are
 * deleted as well.
 *
 * Studio listening: daily totals, listens and supporter opt-ins go before the releases and tracks get fresh ids
 * (`forgetListeningOfPersona`).
 *
 * Studio landing v2: the Studio page card, the founding place and the previews of its own tracks go before the releases and tracks get fresh ids
 * (`forgetLandingTiesOfPersona`).
 *
 * Studio purchases: payment methods, prices and pending claims go, and the
 * sales let go of the persona, before the releases and tracks get fresh ids,
 * while confirmed buyers keep their files (`forgetSalesOfPersona`, whose
 * outcome reaches `onSalesForgotten`).
 *
 * Meet the team: every team link the persona holds on a business listing is
 * deleted (`forgetTeamLinksOfPersona`).
 *
 * Three references hold the persona id with no foreign key and are moved
 * here:
 * - `subprofile_item_revisions.subprofile_id`, the owner's item history.
 * - A moderator takedown in `content_moderation`, which every persona read
 *   looks up by the lowercase id. Left behind, an unlink would lift the
 *   takedown. Only the row under the lowercase id moves: a legacy row under
 *   an uppercase spelling takes no effect today (no read matches it), and
 *   moving it would switch a takedown on as a side effect of the owner's
 *   unlink. It stays on the old id, read by moderators only.
 * - Reports filed on the persona, so an open report still names it and a
 *   takedown decided on one lands on this persona. Matched case-blind,
 *   since reports filed before the id was canonicalised can hold an
 *   uppercase spelling. Moderators alone read a report's subject id
 *   (`GET /reports/mine` leaves it out).
 *
 * The owners' own notifications that carry the id (a feed import ready for
 * review deep-links by it) move too. Rows any other member holds keep the
 * old id, which now resolves nothing.
 *
 * Activity rows keep the old id as well: only a linked persona gets one, and
 * the activity read drops any row whose persona is not a published linked
 * one.
 *
 * Runs inside the caller's transaction, after the persona row is locked.
 * Resolves with the new id.
 */
export async function issueFreshPersonaId(
  manager: EntityManager,
  previousSubprofileId: string,
  onSalesForgotten?: (outcome: StudioSalesUnlinkOutcome) => void,
): Promise<string> {
  const freshSubprofileId = randomUUID();
  await manager.query(`UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`, [
    freshSubprofileId,
    previousSubprofileId,
  ]);
  await manager.query(
    `UPDATE "subprofile_items"
        SET "id" = gen_random_uuid(), "created_at" = now()
      WHERE "subprofile_id" = $1`,
    [freshSubprofileId],
  );
  // Studio v2: playlists credited to the named persona turn private and lose
  // the credit. `FK_studio_playlists_credit_subprofile` carried the credit to
  // the fresh id with the persona row move above. Runs after the items, which
  // stay the statement right behind the row move.
  await releasePlaylistCreditsOfPersona(manager, freshSubprofileId);
  // Studio discovery: credits, staff picks and spotlight places go before the
  // releases and tracks get fresh ids, so none follows them.
  await forgetDiscoveryTiesOfPersona(manager, freshSubprofileId);
  // Studio listening: daily totals, listens and supporter opt-ins go before the releases and tracks get fresh ids.
  await forgetListeningOfPersona(manager, freshSubprofileId);
  // Studio landing v2: the Studio page card, the founding place and the previews of its own tracks go before the releases and tracks get fresh ids.
  await forgetLandingTiesOfPersona(manager, freshSubprofileId);
  await manager.query(
    `UPDATE "subprofile_item_revisions"
        SET "subprofile_id" = $1
      WHERE "subprofile_id" = $2`,
    [freshSubprofileId, previousSubprofileId],
  );
  await manager.query(
    `UPDATE "content_moderation"
        SET "subject_id" = $1, "updated_at" = now()
      WHERE "subject_type" = $3 AND "subject_id" = $2`,
    [
      freshSubprofileId,
      previousSubprofileId,
      SUBPROFILE_MODERATION_SUBJECT_TYPE,
    ],
  );
  // Studio purchases: payment methods, prices, pending claims and the persona link go before the releases and tracks get fresh ids; confirmed buyers keep their files.
  // Runs once the takedown above sits on the fresh id, so a persona under a moderator takedown keeps no files for its buyers.
  const salesOutcome = await forgetSalesOfPersona(manager, freshSubprofileId);
  onSalesForgotten?.(salesOutcome);
  await manager.query(
    `UPDATE "reports"
        SET "subject_id" = $1
      WHERE "subject_type" = $3 AND lower("subject_id") = $2`,
    [freshSubprofileId, previousSubprofileId, ReportSubjectType.Subprofile],
  );
  // `$3` repeats the new id as the uuid the roster compares, so each
  // parameter keeps one type (`$1` is the text written into the payload).
  await manager.query(
    `UPDATE "notifications"
        SET "payload" = jsonb_set("payload", '{subprofileId}', to_jsonb($1::text))
      WHERE "payload" ->> 'subprofileId' = $2
        AND "user_id" IN (
          SELECT "user_id" FROM "subprofile_members" WHERE "subprofile_id" = $3
        )`,
    [freshSubprofileId, previousSubprofileId, freshSubprofileId],
  );
  await manager.query(
    `WITH "remapped" AS MATERIALIZED (
       SELECT "id" AS "previous_id", gen_random_uuid() AS "fresh_id"
         FROM "studio_releases"
        WHERE "subprofile_id" = $1
     ), "moved_reports" AS (
       UPDATE "reports" SET "subject_id" = "remapped"."fresh_id"::text
         FROM "remapped"
        WHERE "reports"."subject_type" = $2
          AND "reports"."subject_id" = "remapped"."previous_id"::text
     )
     UPDATE "studio_releases"
        SET "id" = "remapped"."fresh_id",
            "created_at" = now(),
            "published_at" = CASE WHEN "studio_releases"."published_at" IS NULL THEN NULL ELSE now() END,
            "tracks_changed_at" = NULL,
            "preview_token" = NULL,
            "preview_link_created_at" = NULL,
            "status" = CASE WHEN "studio_releases"."status" = 'scheduled' THEN 'draft' ELSE "studio_releases"."status" END,
            "released_on" = CASE
              WHEN "studio_releases"."status" = 'scheduled'
               AND "studio_releases"."released_on" = ("studio_releases"."publish_at" AT TIME ZONE 'Europe/Lisbon')::date
              THEN NULL
              ELSE "studio_releases"."released_on"
            END,
            "publish_at" = NULL
       FROM "remapped"
      WHERE "studio_releases"."id" = "remapped"."previous_id"`,
    [freshSubprofileId, ReportSubjectType.StudioRelease],
  );
  // Studio safety and moderation: each track's fresh id is drawn once in a
  // MATERIALIZED map, so open `studio_track` reports move to the same id the
  // track gets (case-blind on the stored subject id). Copyright claims
  // follow through `ON UPDATE CASCADE` and are severed right after.
  await manager.query(
    `WITH "track_remap" AS MATERIALIZED (
       SELECT "id" AS "previous_id", gen_random_uuid() AS "fresh_id"
         FROM "studio_tracks"
        WHERE "release_id" IN (
          SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
        )
     ), "moved_track_reports" AS (
       UPDATE "reports" SET "subject_id" = "track_remap"."fresh_id"::text
         FROM "track_remap"
        WHERE "reports"."subject_type" = $2
          AND lower("reports"."subject_id") = "track_remap"."previous_id"::text
     )
     UPDATE "studio_tracks"
        SET "id" = "track_remap"."fresh_id",
            "created_at" = now(),
            "published_at" = CASE WHEN "studio_tracks"."published_at" IS NULL THEN NULL ELSE now() + make_interval(secs => "episode_order"."publish_rank" / 1000.0) END,
            "followers_notified_at" = CASE WHEN "studio_tracks"."followers_notified_at" IS NULL THEN NULL ELSE now() END
       FROM "track_remap", (
         SELECT "ranked_track"."id",
                row_number() OVER (
                  PARTITION BY "ranked_track"."release_id"
                  ORDER BY "ranked_track"."published_at", "ranked_track"."position"
                ) AS "publish_rank"
           FROM "studio_tracks" "ranked_track"
          WHERE "ranked_track"."release_id" IN (
            SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
          )
       ) "episode_order"
      WHERE "episode_order"."id" = "studio_tracks"."id"
        AND "track_remap"."previous_id" = "studio_tracks"."id"
        AND "studio_tracks"."release_id" IN (
        SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
      )`,
    [freshSubprofileId, ReportSubjectType.StudioTrack],
  );
  // Studio safety and moderation: the claims that followed the tracks are
  // severed, so the claimant's view and data export serve the title and
  // artist name kept at filing and never the pseudonymous persona. Staff
  // and the owners keep the cascaded ids. `updated_at` stays as it was, so
  // no stamp marks the unlink on the claimant's row.
  await manager.query(
    `UPDATE "studio_copyright_claims" SET "is_severed" = true
      WHERE "is_severed" = false
        AND "release_id" IN (
          SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
        )`,
    [freshSubprofileId],
  );
  // Studio v3: the reminders members set while the persona was named go
  // (a drop alert under the new name would tell them who it is), version
  // note dates restart like the publish dates above, and the press kit
  // forgets its chosen tracks, whose ids the statement above replaced.
  await manager.query(
    `DELETE FROM "studio_release_reminders"
      WHERE "release_id" IN (
        SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
      )`,
    [freshSubprofileId],
  );
  await manager.query(
    `UPDATE "studio_release_versions" SET "created_at" = now()
      WHERE "release_id" IN (
        SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
      )`,
    [freshSubprofileId],
  );
  await manager.query(
    `UPDATE "studio_press_kits"
        SET "featured_track_ids" = '{}', "updated_at" = now()
      WHERE "subprofile_id" = $1`,
    [freshSubprofileId],
  );
  // Studio dashboard: the milestones the named persona reached go, so no shared card id or reached date ties the pseudonymous persona to its named past. Its followers are already gone, and the hourly sweep finds no placement for it.
  await manager.query(
    `DELETE FROM "studio_artist_milestones" WHERE "subprofile_id" = $1`,
    [freshSubprofileId],
  );
  // Persona posts get fresh ids and restart their dates, as the items do,
  // and open reports on a post move with it. Each restarted date sits one
  // millisecond per place behind now in the old newest-first order, so the
  // Updates list keeps its order.
  await manager.query(
    `WITH "remapped" AS MATERIALIZED (
       SELECT "id" AS "previous_id", gen_random_uuid() AS "fresh_id",
              row_number() OVER (ORDER BY "created_at" DESC, "id" DESC) AS "recency_rank"
         FROM "subprofile_posts"
        WHERE "subprofile_id" = $1
     ), "moved_reports" AS (
       UPDATE "reports" SET "subject_id" = "remapped"."fresh_id"::text
         FROM "remapped"
        WHERE "reports"."subject_type" = $2
          AND "reports"."subject_id" = "remapped"."previous_id"::text
     )
     UPDATE "subprofile_posts"
        SET "id" = "remapped"."fresh_id",
            "created_at" = now() - ("remapped"."recency_rank" * interval '1 millisecond'),
            "edited_at" = NULL
       FROM "remapped"
      WHERE "subprofile_posts"."id" = "remapped"."previous_id"`,
    [freshSubprofileId, ReportSubjectType.PersonaPost],
  );
  await manager.query(
    `DELETE FROM "subprofile_post_quota_entries" WHERE "subprofile_id" = $1`,
    [freshSubprofileId],
  );
  // Meet the team: every team link of the persona goes, so no business
  // listing shows the pseudonymous persona at the named persona's workplace.
  // Unlink locks the persona row first and the foreign key cascade then locks
  // the team rows, the reverse of approve and accept. In a rare race Postgres
  // may abort one side with a deadlock; that is acceptable and the member can
  // retry.
  await forgetTeamLinksOfPersona(manager, freshSubprofileId);
  return freshSubprofileId;
}

/**
 * ENG-447: before an unlink deletes the persona's messaging identity, every
 * block a member placed on that identity becomes a carried block of the
 * persona. The row stops naming the identity (whose delete would otherwise
 * cascade it away) and names the persona instead, so it refuses whichever
 * identity the persona speaks through next, in both directions, as the
 * identity block did (`BlockFilterService.carriedIdentityBlocksAmong` and the
 * mailbox seat predicates). It keeps the retired identity's id, the one the
 * member blocked and the one their Blocked list and unblock use, and the
 * named persona's name: read from the persona row before the edit's save,
 * so it is the name the persona had while it was named. The persona id
 * column cascades on update, so the row follows the persona to its fresh id.
 *
 * Runs inside the unlink transaction, after the persona row is locked.
 */
export async function carryIdentityBlocksToPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(
    `UPDATE "identity_blocks"
        SET "blocked_subprofile_id" = "persona"."id",
            "retired_identity_id" = "identity_blocks"."identity_id",
            "blocked_name_snapshot" = "persona"."display_name",
            "identity_id" = NULL
       FROM "identities" "persona_identity"
      INNER JOIN "subprofiles" "persona"
         ON "persona"."id" = "persona_identity"."subprofile_id"
      WHERE "persona_identity"."id" = "identity_blocks"."identity_id"
        AND "persona_identity"."kind" = 'subprofile'
        AND "persona_identity"."subprofile_id" = $1`,
    [subprofileId],
  );
}
