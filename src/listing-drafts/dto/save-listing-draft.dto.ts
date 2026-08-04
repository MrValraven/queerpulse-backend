import { IsObject, IsOptional, IsUUID } from 'class-validator';

/**
 * Body of `POST /listing-drafts` — the autosave upsert.
 *
 * `id` is the server-generated uuid the caller received from a previous save;
 * it is optional so the very first save (no id yet) creates a fresh draft. On
 * a subsequent save the frontend echoes the id back so the same row is
 * updated in place (see `ListingDraftsService.save`).
 *
 * `payload` is the whole `ListingDraft` wizard state, stored opaquely. It is
 * only validated as "an object" here: its inner shape is owned by the frontend
 * wizard, so the global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`)
 * must NOT strip or reject its unknown inner keys — declaring it `@IsObject()`
 * (rather than `@ValidateNested()` against a fixed class) keeps the arbitrary
 * jsonb intact. A coarse size cap is enforced in the service, not here.
 */
export class SaveListingDraftDto {
  @IsOptional() @IsUUID() id?: string;

  @IsObject() payload!: Record<string, unknown>;
}
