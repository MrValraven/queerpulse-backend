import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';

/**
 * "Persona member" in every Studio dashboard block check means the creator and
 * every co-owner. The persona creator is read from `subprofiles.user_id` as
 * well as from `subprofile_members`, so a creator row missing from the members
 * table still counts. `personaIdExpression` is spliced verbatim (a quoted
 * column, `$1` or `:name`).
 */
export function personaMemberUserIdsSql(personaIdExpression: string): string {
  return `(
    SELECT "persona_member"."user_id"
    FROM "subprofile_members" "persona_member"
    WHERE "persona_member"."subprofile_id" = ${personaIdExpression}
    UNION
    SELECT "persona_creator"."user_id"
    FROM "subprofiles" "persona_creator"
    WHERE "persona_creator"."id" = ${personaIdExpression}
  )`;
}

/**
 * True when the user blocked, or was blocked by, any member of the persona.
 * A NULL user id reads as not blocked.
 */
export function blockedWithAnyPersonaMemberSql(
  userIdExpression: string,
  personaIdExpression: string,
): string {
  return `EXISTS (
    SELECT 1
    FROM "blocks" "persona_member_block"
    WHERE (
      "persona_member_block"."blocker_id" = ${userIdExpression}
      AND "persona_member_block"."blocked_id" IN ${personaMemberUserIdsSql(personaIdExpression)}
    ) OR (
      "persona_member_block"."blocked_id" = ${userIdExpression}
      AND "persona_member_block"."blocker_id" IN ${personaMemberUserIdsSql(personaIdExpression)}
    )
  )`;
}

/**
 * Ruling 4: true when any blocker in `blockerUserIdsSql` (a parenthesised list
 * with one `user_id` column, such as `personaMemberUserIdsSql('$1')` or
 * `($2::uuid)`) blocked the persona's identity. The block is direct when
 * `identity_id` names an `identities` row whose `subprofile_id` is the persona,
 * and carried when `blocked_subprofile_id` is the persona. A NULL persona
 * expression reads as not blocked.
 */
export function personaIdentityBlockedBySql(
  blockerUserIdsSql: string,
  blockedPersonaIdExpression: string,
): string {
  return `EXISTS (
    SELECT 1
    FROM "identity_blocks" "persona_identity_block"
    WHERE "persona_identity_block"."blocker_user_id" IN ${blockerUserIdsSql}
      AND (
        "persona_identity_block"."blocked_subprofile_id" = ${blockedPersonaIdExpression}
        OR "persona_identity_block"."identity_id" IN (
          SELECT "blocked_identity"."id"
          FROM "identities" "blocked_identity"
          WHERE "blocked_identity"."subprofile_id" = ${blockedPersonaIdExpression}
        )
      )
  )`;
}

/**
 * Owner side only: a chosen persona that is removed or under a moderator
 * takedown (the `listenablePersonaSql` moderation rule) drops the supporter
 * until they pick a new identity; a private or draft one still shows. Shared by
 * the listen supporters and the supporter wall.
 */
export function chosenPersonaShowableSql(
  chosenPersonaIdExpression: string,
): string {
  return `EXISTS (
     SELECT 1 FROM "subprofiles" "chosen_persona"
      WHERE "chosen_persona"."id" = ${chosenPersonaIdExpression}
        AND "chosen_persona"."removed_at" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "content_moderation" "chosen_persona_moderation"
           WHERE "chosen_persona_moderation"."subject_type" = '${SUBPROFILE_MODERATION_SUBJECT_TYPE}'
             AND "chosen_persona_moderation"."subject_id" = "chosen_persona"."id"::text
             AND (
               "chosen_persona_moderation"."hidden_at" IS NOT NULL
               OR "chosen_persona_moderation"."removed_at" IS NOT NULL
             )
        )
   )`;
}
