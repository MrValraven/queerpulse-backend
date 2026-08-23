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
 * Body for `POST /communities/:slug/resources` (owner, co-owner or moderator).
 *
 * `position` is absent on purpose: order is owned by
 * `PATCH /communities/:slug/resources/order`, so there is exactly one way to
 * change it. A new resource is appended to the end of the shelf.
 *
 * `title` and `note` are stored as plain text: `CommunityResourcesService`
 * runs them through `toStoredPlainText` before they reach the column, so no
 * markup is ever persisted (see `community-plain-text.ts`).
 */
export class CreateCommunityResourceDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;

  // Absolute `http:`/`https:` only. `javascript:` and `data:` are refused by
  // `@IsHttpUrl`'s protocol allowlist, because the shelf renders this value as
  // a real anchor for every member of the community.
  @IsString() @MaxLength(2048) @IsHttpUrl() url!: string;

  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;

  @IsEnum(CommunityResourceKind) kind!: CommunityResourceKind;
}
