import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { COMMUNITY_TAGS } from '../community-tags';
import { AccessTier, CommunityType } from '../entities/community.entity';

/**
 * The only values a community's `features` array may contain (spec: Phase A
 * / Request DTOs). The `communities.features` column is a plain `text[]` —
 * no dedicated entity enum backs it — so the literal set lives here, next to
 * the one DTO field that validates against it.
 */
export const COMMUNITY_FEATURES = [
  'discussion',
  'events',
  'rooms',
  'roster',
  'library',
] as const;
export type CommunityFeature = (typeof COMMUNITY_FEATURES)[number];

export class CreateCommunityDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MinLength(1) @MaxLength(5000) purpose!: string;
  @IsEnum(CommunityType) type!: CommunityType;
  @IsString() @MinLength(1) @MaxLength(2000) whoFor!: string;
  @IsEnum(AccessTier) accessTier!: AccessTier;
  @IsBoolean() rosterVisible!: boolean;

  @IsArray()
  @ArrayMaxSize(COMMUNITY_FEATURES.length)
  @IsIn(COMMUNITY_FEATURES, { each: true })
  features!: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  rules!: string[];

  @IsString() @MinLength(1) @MaxLength(200) tagline!: string;

  // Curated browse tags picked from the fixed `COMMUNITY_TAGS` vocabulary
  // (`src/communities/community-tags.ts`) — NOT freeform, unlike
  // `forum_thread.tags`. Optional: a community can carry no tags.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(COMMUNITY_TAGS, { each: true })
  tags?: string[];

  // Optional cover image. A storage key from the `community-cover` upload kind,
  // an absolute `https://` URL, or `''`/`null` to clear it. `@IsImageReference`
  // (not `@IsUrl`) rejects `javascript:`/`data:`/`http:`; the global
  // StorageKeyOwnershipInterceptor enforces the key was uploaded by the caller.
  @IsOptional() @IsImageReference() coverImageUrl?: string | null;

  // Desired slug; `CommunitiesService.createWithUniqueRef` slugifies +
  // de-dupes it. Ignored entirely on PATCH (see `UpdateCommunityDto`).
  @IsString() @MinLength(1) @MaxLength(100) handle!: string;

  // Member slugs proposed as moderators. Each resolved member gets a
  // `CommunityInviteReceived` notification carrying `proposedRole: 'mod'` —
  // this is an INVITATION, never a roster add: nobody is made a moderator of a
  // community they never agreed to join (BE-COM-06). The owner promotes them
  // with `PATCH /communities/:slug/members/:memberSlug` once they join. See
  // `CommunitiesService.resolveInvitees`.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  stewards?: string[];

  // Member slugs -> each resolved invitee gets a `CommunityInviteReceived`
  // notification, but is never force-added to the roster (no consent-less
  // roster adds; see `CommunitiesService.resolveInvitees`/`notifyInvitees`).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  invites?: string[];
}
