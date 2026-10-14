import {
  PersonaColumns,
  notBlockedEitherWaySql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import {
  StudioPersonaCreditPublic,
  StudioReleaseCreditSummary,
  creditRoleRank,
  orderedCreditRoles,
  toStudioPersonaRef,
} from './studio-persona-credit-response';
import { playableTrackAudioSql } from './studio-playlist-visibility';
import { listenablePersonaSql } from './studio-visibility';
import { isStudioCreditRole } from './studio.constants';

/*
 * Studio discovery: the public side of persona credits. Only accepted
 * credits to personas that are public right now, with their creator clear
 * of blocks either way with the viewer (`$1`; a null viewer is the staff
 * view, which no block row matches). A credit whose persona stops being
 * public drops out here and its row stays, so it returns with the persona.
 */

/** The public-credit rule both reads below share: an accepted credit to a
 *  listenable persona whose creator is clear of blocks either way with the
 *  viewer at `$1`. Aliases `credit` and `persona`. Each read also requires a
 *  playable credited track, so a track still uploading names nobody. */
const PUBLIC_CREDIT_PREDICATE_SQL = `"credit"."status" = 'accepted'
   AND ${listenablePersonaSql('persona')}
   AND ${notBlockedEitherWaySql('$1', '"persona"."user_id"', 'credited_block')}`;

/** `$1` the viewer or null, `$2` the track. */
export const TRACK_PUBLIC_CREDITS_SQL = `SELECT "credit"."role" AS "role",
       ${personaColumnsSql('persona', 'persona')}
  FROM "studio_persona_credits" "credit"
  INNER JOIN "studio_tracks" "track" ON "track"."id" = "credit"."track_id"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "credit"."subprofile_id"
 WHERE "credit"."track_id" = $2
   AND (${playableTrackAudioSql('track', 'release')})
   AND ${PUBLIC_CREDIT_PREDICATE_SQL}
 ORDER BY "credit"."created_at" ASC, "credit"."id" ASC`;

/** `$1` the viewer or null, `$2` the release. Track order first, so the
 *  summary lists each persona under the first track that credits it. */
export const RELEASE_CREDIT_SUMMARY_SQL = `SELECT "credit"."role" AS "role",
       ${personaColumnsSql('persona', 'persona')}
  FROM "studio_persona_credits" "credit"
  INNER JOIN "studio_tracks" "track" ON "track"."id" = "credit"."track_id"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "credit"."subprofile_id"
 WHERE "track"."release_id" = $2
   AND (${playableTrackAudioSql('track', 'release')})
   AND ${PUBLIC_CREDIT_PREDICATE_SQL}
 ORDER BY "track"."position" ASC, "credit"."created_at" ASC, "credit"."id" ASC`;

export type PublicCreditRow = Record<string, unknown> & { role: string };

/** Ordered by role vocabulary; the stable sort keeps request order within
 *  a role. A stored role outside the vocabulary is dropped. */
export function toPublicTrackCredits(
  rows: PublicCreditRow[],
): StudioPersonaCreditPublic[] {
  return rows
    .flatMap((row) =>
      isStudioCreditRole(row.role)
        ? [
            {
              persona: toStudioPersonaRef(
                personaColumnsFromRow(row, 'persona'),
                true,
              ),
              role: row.role,
            },
          ]
        : [],
    )
    .sort(
      (leftCredit, rightCredit) =>
        creditRoleRank(leftCredit.role) - creditRoleRank(rightCredit.role),
    );
}

/** One row per persona in first-seen order, distinct roles in vocabulary
 *  order. */
export function toReleaseCreditSummary(
  rows: PublicCreditRow[],
): StudioReleaseCreditSummary[] {
  const rolesByPersonaId = new Map<
    string,
    { columns: PersonaColumns; roles: string[] }
  >();
  for (const row of rows) {
    const columns = personaColumnsFromRow(row, 'persona');
    const entry = rolesByPersonaId.get(columns.id) ?? { columns, roles: [] };
    entry.roles.push(row.role);
    rolesByPersonaId.set(columns.id, entry);
  }
  return [...rolesByPersonaId.values()].flatMap(({ columns, roles }) => {
    const orderedRoles = orderedCreditRoles(roles);
    return orderedRoles.length
      ? [{ persona: toStudioPersonaRef(columns, true), roles: orderedRoles }]
      : [];
  });
}
