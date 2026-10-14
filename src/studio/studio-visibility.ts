import {
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';

/**
 * Studio v1: the one spelling of "this persona's releases can be heard".
 * Every listening read (home, search, release, track, artist, stream), the
 * uploadable persona list and the saved-card availability check use it, so
 * a persona that is unpublished, removed, missing its handle or under a
 * moderator takedown drops out of all of them at once. A persona set to
 * network or private is shown only to its chosen audience, so Studio lists
 * open personas only.
 *
 * The takedown arm mirrors `SubprofilePublicReadService
 * .excludeModeratedSubprofiles`: hidden and removed both count, keyed by the
 * persona's uuid as text. `personaAlias` is a literal alias from this
 * module's own query builders; member input never reaches it. Blocks are applied
 * separately with `BlockFilterService.excludeBlocked` on `"<alias>"."user_id"`,
 * since that one binds a parameter.
 */
export function listenablePersonaSql(personaAlias: string): string {
  const persona = `"${personaAlias}"`;
  return `(${persona}."status" = '${SubprofileStatus.Published}'
    AND ${persona}."removed_at" IS NULL
    AND ${persona}."handle" IS NOT NULL
    AND ${persona}."visibility" = '${SubprofileVisibility.Open}'
    AND NOT EXISTS (
      SELECT 1 FROM "content_moderation" "studio_persona_moderation"
       WHERE "studio_persona_moderation"."subject_type" = '${SUBPROFILE_MODERATION_SUBJECT_TYPE}'
         AND "studio_persona_moderation"."subject_id" = ${persona}."id"::text
         AND (
           "studio_persona_moderation"."hidden_at" IS NOT NULL
           OR "studio_persona_moderation"."removed_at" IS NOT NULL
         )
    ))`;
}

/**
 * Open demo pages: a release listeners once heard that staff took down. It
 * was live when it came down (`published_at` survives a takedown and only
 * an unpublish clears it) and its persona is still listenable, so the
 * release page answers 410 `studio_release_withdrawn`, a saved card reads
 * "withdrawn" and an owner's playlist row does too. Every other unavailable
 * release keeps the plain 404, so the 410 confirms nothing a listener of the
 * release did not already know. Blocks are applied separately with
 * `BlockFilterService.excludeBlocked` on `"<persona>"."user_id"`, as for
 * `listenablePersonaSql`. Both aliases are literals from this module's own
 * query builders.
 */
export function withdrawnReleaseSql(
  releaseAlias: string,
  personaAlias: string,
): string {
  const release = `"${releaseAlias}"`;
  return `(${release}."status" = '${StudioReleaseStatus.TakenDown}'
    AND ${release}."published_at" IS NOT NULL
    AND ${listenablePersonaSql(personaAlias)})`;
}

/** The release-row half of `withdrawnReleaseSql`, for a release already
 *  loaded; the persona half is a query (`isPersonaListenable`). */
export function isReleaseWithdrawnForListeners(
  release: Pick<StudioRelease, 'status' | 'publishedAt'>,
): boolean {
  return (
    release.status === StudioReleaseStatus.TakenDown &&
    release.publishedAt !== null
  );
}

/**
 * Studio v3: the persona rule a private preview link answers under. The
 * release has not come out, so the persona may still be a draft or set to
 * network or private; a link stops working once its owners remove the
 * persona or a moderator takes it down (the same hidden and removed rule
 * as `listenablePersonaSql`). Blocks are applied separately.
 */
export function previewablePersonaSql(personaAlias: string): string {
  const persona = `"${personaAlias}"`;
  return `(${persona}."removed_at" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "content_moderation" "preview_persona_moderation"
       WHERE "preview_persona_moderation"."subject_type" = '${SUBPROFILE_MODERATION_SUBJECT_TYPE}'
         AND "preview_persona_moderation"."subject_id" = ${persona}."id"::text
         AND (
           "preview_persona_moderation"."hidden_at" IS NOT NULL
           OR "preview_persona_moderation"."removed_at" IS NOT NULL
         )
    ))`;
}
