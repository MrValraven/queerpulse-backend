import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /communities/:slug/tag-requests` — an owner/mod's free-text
 * "I wish this tag existed" feedback. `label` is the tag they're asking for;
 * `note` is optional context on why they want it. Neither is validated
 * against `COMMUNITY_TAGS` — this is deliberately freeform feedback, not a
 * pick from the curated vocabulary (see `CommunityTagRequest`'s docstring).
 */
export class CreateCommunityTagRequestDto {
  @IsString()
  @MaxLength(60)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
