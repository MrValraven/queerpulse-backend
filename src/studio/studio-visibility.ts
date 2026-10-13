import {
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';

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
