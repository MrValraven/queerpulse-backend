import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { ReportSubjectType } from '../reports/entities/report.entity';
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
