import { toImageUrl } from '../common/image-url';
import { storageKeyOwnerId } from '../storage/storage-key';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { STUDIO_ARTIST_KIND_LIST_SQL } from './studio-discovery-sql';
import { personaMemberUserIdsSql } from './studio-persona-members';
import { playableTrackSql } from './studio-playlist-visibility';
import { listenablePersonaSql } from './studio-visibility';

/*
 * Studio landing v2 (contract section 1): the one spelling of what the public
 * Studio page may show. Every read of contract sections 2, 3, 9 and 10 uses
 * these rules, so an artist or a track that stops qualifying drops out of the
 * public payload, the preview stream, the staff list and the owner list at
 * once. They serve public reads, so they carry no viewer and no block filter;
 * a member read that reuses one adds `notBlockedEitherWaySql` on
 * `"<persona>"."user_id"` as `LISTENABLE_ARTIST_SQL` does. Every alias passed
 * in is a literal from Studio's own queries; member input only ever reaches
 * bound parameters.
 */

/** Contract 1.2: the reasons a track may not play on the landing, in the
 *  order the staff read reports the first failing one. */
export const STUDIO_LANDING_INELIGIBLE_REASONS = [
  'not_playable',
  'persona_not_eligible',
  'podcast',
  'content_warnings',
  'explicit',
  'open_claim',
] as const;

export type StudioLandingIneligibleReason =
  (typeof STUDIO_LANDING_INELIGIBLE_REASONS)[number];

/** The time zone of the landing month count (`counts.eventsThisMonth`): the
 *  month runs from Lisbon local midnight on the 1st. */
export const STUDIO_LANDING_EVENT_TIME_ZONE = 'Europe/Lisbon';

/** Contract 1.1: a persona the landing may show. A Studio artist kind, a
 *  listenable persona and a creator whose account is active. */
export function landingArtistPersonaSql(personaAlias: string): string {
  const persona = `"${personaAlias}"`;
  const creator = `"${personaAlias}_creator"`;
  return `(${persona}."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
    AND ${listenablePersonaSql(personaAlias)}
    AND EXISTS (
      SELECT 1 FROM "users" ${creator}
       WHERE ${creator}."id" = ${persona}."user_id"
         AND ${creator}."status" = '${UserStatus.Active}'
    ))`;
}

/** Contract 1.1: a landing persona with at least one live release. The
 *  artist count and the release count read it. */
export function landingLiveArtistSql(personaAlias: string): string {
  const persona = `"${personaAlias}"`;
  const liveRelease = `"${personaAlias}_live_release"`;
  return `(${landingArtistPersonaSql(personaAlias)}
    AND EXISTS (
      SELECT 1 FROM "studio_releases" ${liveRelease}
       WHERE ${liveRelease}."subprofile_id" = ${persona}."id"
         AND ${liveRelease}."status" = 'published'
    ))`;
}

export interface StudioLandingPreviewRule {
  reason: StudioLandingIneligibleReason;
  conditionSql: string;
}

/**
 * Contract 1.2: the six conditions a track meets to play on the landing, in
 * the contract order. Each entry is one rule with the reason the staff read
 * reports when it fails. Staff can drop the podcast rule or the explicit rule
 * by deleting its entry here and its reason from
 * `STUDIO_LANDING_INELIGIBLE_REASONS`; the eligible test and the reason read
 * follow this list.
 */
export function landingPreviewRulesSql(
  trackAlias: string,
  releaseAlias: string,
  personaAlias: string,
): readonly StudioLandingPreviewRule[] {
  const track = `"${trackAlias}"`;
  const release = `"${releaseAlias}"`;
  const openClaim = `"${trackAlias}_open_claim"`;
  return [
    {
      reason: 'not_playable',
      conditionSql: playableTrackSql(trackAlias, releaseAlias, personaAlias),
    },
    {
      reason: 'persona_not_eligible',
      conditionSql: landingArtistPersonaSql(personaAlias),
    },
    {
      reason: 'podcast',
      conditionSql: `${release}."type" <> 'podcast'`,
    },
    {
      reason: 'content_warnings',
      conditionSql: `cardinality(${track}."content_warnings") = 0 AND cardinality(${track}."staff_content_warnings") = 0`,
    },
    {
      reason: 'explicit',
      conditionSql: `${track}."is_explicit" = false`,
    },
    {
      reason: 'open_claim',
      conditionSql: `NOT EXISTS (
      SELECT 1 FROM "studio_copyright_claims" ${openClaim}
       WHERE ${openClaim}."track_id" = ${track}."id"
         AND ${openClaim}."status" IN ('submitted', 'accepted', 'countered')
    )`,
    },
  ];
}

/** Contract 1.2: every rule at once, each in its own parentheses. */
export function landingPreviewEligibleSql(
  trackAlias: string,
  releaseAlias: string,
  personaAlias: string,
): string {
  const conditions = landingPreviewRulesSql(
    trackAlias,
    releaseAlias,
    personaAlias,
  ).map((rule) => `(${rule.conditionSql})`);
  return `(${conditions.join(' AND ')})`;
}

/** Contract 9.2: the first failing rule in the contract order, or NULL for a
 *  track that may play. A rule that reads NULL counts as failing, the way
 *  the eligible test drops it. */
export function landingPreviewIneligibleReasonSql(
  trackAlias: string,
  releaseAlias: string,
  personaAlias: string,
): string {
  const branches = landingPreviewRulesSql(
    trackAlias,
    releaseAlias,
    personaAlias,
  ).map(
    (rule) =>
      `WHEN NOT COALESCE((${rule.conditionSql}), false) THEN '${rule.reason}'`,
  );
  return `CASE ${branches.join(' ')} ELSE NULL END`;
}

/**
 * The persona members (`personaMemberUserIdsSql`) who hold a Studio grant
 * and whose account is active: the owners who can answer a preview request.
 * A parenthesised subquery with one `user_id` column. `aliasPrefix` names
 * this use's own aliases, so one query can carry several.
 */
export function grantHoldingPersonaMembersSql(
  personaIdExpression: string,
  aliasPrefix: string,
): string {
  const owner = `"${aliasPrefix}_owner"`;
  const grant = `"${aliasPrefix}_grant"`;
  const ownerAccount = `"${aliasPrefix}_account"`;
  return `(
    SELECT ${owner}."user_id" AS "user_id"
      FROM ${personaMemberUserIdsSql(personaIdExpression)} ${owner}
     INNER JOIN "studio_access_grants" ${grant}
        ON ${grant}."user_id" = ${owner}."user_id"
     INNER JOIN "users" ${ownerAccount}
        ON ${ownerAccount}."id" = ${owner}."user_id"
       AND ${ownerAccount}."status" = '${UserStatus.Active}'
  )`;
}

/**
 * Contract delta 1 (contract 1.3): an image URL a public landing payload may
 * carry, by the public persona page rule of `/p/:handle`. A linked persona
 * already shows its avatar URL, with its owner's name and slug, to anyone
 * signed out on that page, so its image goes out through `toImageUrl`. For
 * an unlinked persona a persona-scoped, landing-scoped or absolute URL
 * passes, and a key whose middle segment names a member reads null, so the
 * frontend shows its tinted placeholder.
 */
export function landingImageUrl(
  value: string | null | undefined,
  linkVisibility: string,
): string | null {
  if (!value) {
    return null;
  }
  if (linkVisibility === String(SubprofileLinkVisibility.Linked)) {
    return toImageUrl(value);
  }
  return storageKeyOwnerId(value) === null ? toImageUrl(value) : null;
}
