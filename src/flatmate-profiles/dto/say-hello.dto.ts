import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /flatmate-profiles/:slug/hello body. Optional — when empty, the service
 * sends a default greeting. */
export class SayHelloDto {
  @IsOptional() @IsString() @MaxLength(2000) body?: string;

  /**
   * Opt-in, per-connection pronoun pre-share (GDPR Art.9). When `true`, the
   * sender's OWN pronouns are appended to this greeting — but ONLY if the sender
   * has already granted Art.9 storage consent on their flatmate profile (the
   * existing `specialCategoryConsentAt` gate) and actually stored pronouns.
   * Nothing else special-category is ever shared this way. The response's
   * `pronounsShared` reports whether it took effect, so the client never has to
   * assume. */
  @IsOptional() @IsBoolean() sharePronouns?: boolean;
}
