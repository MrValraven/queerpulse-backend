import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { ProfileVisibility } from '../../users/entities/profile.entity';
import { MAX_FEATURED_COMMUNITIES } from '../featured-communities';
import { INTEREST_LABELS } from '../identities';
import { LANGUAGE_CODES } from '../languages';
import {
  MAX_NOW_LENGTH,
  MAX_OPEN_TO_ENTRIES,
  MAX_OPEN_TO_LABEL_LENGTH,
  OPEN_TO_PRESET_IDS,
} from '../open-to';
import { DISCIPLINE_IDS, PROFESSIONS_BY_DISCIPLINE } from '../professions';

const ALL_PROFESSION_IDS = Object.values(PROFESSIONS_BY_DISCIPLINE).flat();

// One class covers both arms of the OpenToEntry union. `@ValidateIf` on `kind`
// keeps the irrelevant arm's field unvalidated without removing it from the
// whitelist, so the global ValidationPipe's `forbidNonWhitelisted` still
// rejects stray properties on an entry.
export class OpenToEntryDto {
  @IsIn(['preset', 'custom'])
  kind!: string;

  // An unknown id is a 400 here, never a stored value: the client drops ids it
  // does not recognise on read, so a stored unknown id would be
  // invisible-but-filterable data.
  @ValidateIf((o: OpenToEntryDto) => o.kind === 'preset')
  @IsIn(OPEN_TO_PRESET_IDS)
  id?: string;

  // Stored verbatim (whitespace trim only) by normalizeOpenTo — this is the
  // long tail the taxonomy does not cover, so it is not normalised.
  @ValidateIf((o: OpenToEntryDto) => o.kind === 'custom')
  @IsString()
  @MaxLength(MAX_OPEN_TO_LABEL_LENGTH)
  label?: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsString() @MaxLength(100) pronouns?: string;
  // How the member's name is said aloud — a short phonetic hint, distinct from
  // `pronouns`. Same "empty string clears" pattern as `now`/`bioPt`/
  // `notHereFor` — see ProfilesService.updateMe.
  @IsOptional() @IsString() @MaxLength(80) pronunciation?: string;
  @IsOptional() @IsString() @MaxLength(160) tagline?: string;
  @IsOptional() @IsString() @MaxLength(5000) bio?: string;
  // Portuguese translation of `bio`, shown alongside it when present. Same
  // "empty string clears" pattern as `now` — see ProfilesService.updateMe.
  @IsOptional() @IsString() @MaxLength(2000) bioPt?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;

  // `@IsOptional()` treats both `undefined` and `null` as "skip", so `null` and
  // `''` both clear the avatar back to the Google OAuth fallback.
  @IsOptional() @IsImageReference() avatarUrl?: string | null;

  // `''` is meaningful — it CLEARS the status (the frontend hides the whole Now
  // section when empty), so this is not treated as "no change". See
  // ProfilesService.updateMe.
  @IsOptional() @IsString() @MaxLength(MAX_NOW_LENGTH) now?: string;

  // ISO string sets a 24h-from-now-ish value chosen by the caller; `null`
  // clears it early ("bring me back"). The FE always sends
  // `new Date(Date.now() + 24*60*60*1000).toISOString()` or `null` — the
  // backend does not recompute "24 hours", it just stores whatever timestamp
  // it's given and treats `hiddenUntil > now()` as hidden.
  @IsOptional()
  @ValidateIf((_o, v: unknown) => v !== null)
  @IsISO8601()
  hiddenUntil?: string | null;

  // What the member is explicitly NOT here for — shown alongside `now`. Same
  // "empty string clears" pattern — see ProfilesService.updateMe.
  @IsOptional() @IsString() @MaxLength(280) notHereFor?: string;

  @IsOptional() @IsEnum(ProfileVisibility) visibility?: ProfileVisibility;

  // A full REPLACE of the list, not a merge — consistent with
  // PUT /profiles/me/socials|work|skills.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_OPEN_TO_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => OpenToEntryDto)
  openTo?: OpenToEntryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  // Private Settings → Interests preferences — never shown on the public profile.
  //
  // Range-checked against the canonical vocabulary now that a member can PUBLISH
  // a subset of these for directory search (`discoverable_identities`). A free
  // string was acceptable while nothing queried the column; it is not acceptable
  // for a value that can end up in a search index, and the DB's subset CHECK
  // constrains the published set to this one, so an off-vocabulary value here
  // would be unpublishable-but-stored — see src/profiles/identities.ts.
  //
  // Dropping an entry here also UN-PUBLISHES it; ProfilesService.updateMe prunes
  // `discoverableIdentities` in the same write.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsIn(INTEREST_LABELS, { each: true })
  identities?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  lookingFor?: string[];

  // Professional-identity facts — see Profile.discipline/profession/languages
  // and src/profiles/professions.ts. `profession` implies its parent
  // `discipline`; ProfilesService.updateMe reconciles the two so a member who
  // picks a profession without its field doesn't end up unfindable by field.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsIn(DISCIPLINE_IDS, { each: true })
  discipline?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsIn(ALL_PROFESSION_IDS, { each: true })
  profession?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LANGUAGE_CODES.length)
  @IsIn(LANGUAGE_CODES, { each: true })
  languages?: string[];

  // Whether `lookingFor` is shown on the profile to other viewers.
  @IsOptional()
  @IsBoolean()
  lookingForPublic?: boolean;

  // Whether the member's trust network (vouchers/vouches) is hidden on
  // member-facing surfaces. See Profile.privateNetwork.
  @IsOptional()
  @IsBoolean()
  privateNetwork?: boolean;

  // Whether `avatarUrl` is shown to non-owner viewers. Owner always sees the
  // real photo regardless — see toFullProfile's isOwner gating.
  @IsOptional()
  @IsBoolean()
  photoVisible?: boolean;

  // Whether `location` is shown to non-owner viewers. Owner always sees it
  // regardless — see toFullProfile's isOwner gating.
  @IsOptional()
  @IsBoolean()
  hoodVisible?: boolean;

  // Whether the vouchers-list endpoint (`GET /members/:slug/vouchers`) shows
  // names to non-owner viewers, vs. count-only. Owner always sees the real
  // list — see VouchService.listVouchers.
  @IsOptional()
  @IsBoolean()
  vouchersVisible?: boolean;

  // Whether the member consents to being featured (member quote /
  // changemaker highlight) on the admin-curated live landing page. See
  // Profile.featuredConsent.
  @IsOptional()
  @IsBoolean()
  featuredConsent?: boolean;

  // Ordered slugs of the communities the member pins to their profile's
  // "Communities" section — a full REPLACE of the pin set, not a merge, so
  // `[]` clears it. Each slug must be a NON-PRIVATE community the member is
  // actually on the roster of; ProfilesService.updateMe rejects anything else
  // (the frontend picker only offers eligible communities, this is the server
  // enforcing the same). Capped server-side, mirroring the picker's cap.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FEATURED_COMMUNITIES)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  featuredCommunities?: string[];
}
