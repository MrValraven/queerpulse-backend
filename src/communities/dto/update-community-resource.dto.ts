import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsHttpUrl } from '../is-http-url.validator';
import { CommunityResourceKind } from '../entities/community-resource.entity';

/**
 * Body for `PATCH /communities/:slug/resources/:id` (owner, co-owner or
 * moderator). Every field optional; an omitted field is left alone.
 *
 * `note` accepts `null` or `''` to clear it back to none, the same contract
 * `UpdateFlatPostDto.image` uses (`@IsOptional()` treats `null` as "skip
 * validation", and the service reads "present but empty" as a clear).
 *
 * No `position` here either: reordering is `PATCH
 * /communities/:slug/resources/order`, which sets the whole shelf's order in
 * one call rather than leaving positions to drift one PATCH at a time.
 */
export class UpdateCommunityResourceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;

  @IsOptional() @IsString() @MaxLength(2048) @IsHttpUrl() url?: string;

  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;

  @IsOptional() @IsEnum(CommunityResourceKind) kind?: CommunityResourceKind;
}
