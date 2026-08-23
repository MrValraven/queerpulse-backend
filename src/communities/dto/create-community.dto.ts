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
import { LANGUAGE_CODES } from '../../profiles/languages';
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

  // The community's small square identity mark, alongside the wide
  // `coverImageUrl` banner. Same convention as that field in every respect: a
  // storage key (from the `community-avatar` upload kind), an absolute
  // `https://` URL, or `''`/`null` to clear it, validated by
  // `@IsImageReference` so `javascript:`/`data:`/`http:` are refused, with the
  // global StorageKeyOwnershipInterceptor plus
  // `assertNoForeignUploadIntroduced` in the service enforcing the key was the
  // caller's own upload.
  @IsOptional() @IsImageReference() avatarImageUrl?: string | null;

  // Owner-authored greeting a new member sees ONCE after joining (see
  // `Community.welcomeMessage`). Free text from a member-facing form, so it is
  // stripped to plain text at the write boundary by `toStoredPlainTextOrNull`
  // before it is stored; `''`/`null` clears it.
  @IsOptional() @IsString() @MaxLength(2000) welcomeMessage?: string | null;

  // Where the community actually meets. `city` is the city label, `area` the
  // neighbourhood or region inside it, and `isOnline` marks a community that
  // gathers on a call. The two are not exclusive: a local group that also
  // meets online is both. `city`/`area` are plain text and are sanitized on
  // write like `welcomeMessage`; `''`/`null` clears either.
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @IsString() @MaxLength(120) area?: string | null;
  @IsOptional() @IsBoolean() isOnline?: boolean;

  // Languages the community runs in, picked from the SAME fixed vocabulary
  // `profiles.languages` uses (`src/profiles/languages.ts`) so a member's own
  // languages and a community's are comparable values rather than two lists
  // that drift. Same `@IsIn(..., { each: true })` shape as `tags` above.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LANGUAGE_CODES.length)
  @IsIn(LANGUAGE_CODES, { each: true })
  languages?: string[];

  // Owner opt-in to a signed-out TEASER of this community (see
  // `Community.isPubliclyListed` for exactly what that exposes). Owner-level
  // only, and only meaningful for the `public`/`request` tiers: the service
  // refuses to set it true on an `invite`/`private` community and forces it
  // back to false if the tier later moves there.
  @IsOptional() @IsBoolean() isPubliclyListed?: boolean;

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
