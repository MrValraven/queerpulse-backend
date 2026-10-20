import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  LISTING_TEAM_LIMITS,
  LISTING_TEAM_SEARCH,
} from '../listing-team.constants';

/** Trims a string and turns an empty result into null; any other value passes through. */
export function normalizeRoleLabel({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const NO_LINE_BREAK = /^[^\r\n\u2028\u2029\u0085]*$/;

export class InviteListingTeamMemberDto {
  @IsUUID('all')
  subprofileId!: string;

  @IsOptional()
  @Transform(normalizeRoleLabel)
  @IsString()
  @MaxLength(LISTING_TEAM_LIMITS.roleLabelMax)
  @Matches(NO_LINE_BREAK)
  roleLabel?: string | null;
}

export class ApproveListingTeamRequestDto {
  @IsOptional()
  @Transform(normalizeRoleLabel)
  @IsString()
  @MaxLength(LISTING_TEAM_LIMITS.roleLabelMax)
  @Matches(NO_LINE_BREAK)
  roleLabel?: string | null;
}

export class UpdateListingTeamMemberDto {
  @ValidateIf((body: UpdateListingTeamMemberDto) => body.roleLabel !== null)
  @Transform(normalizeRoleLabel)
  @IsString()
  @MaxLength(LISTING_TEAM_LIMITS.roleLabelMax)
  @Matches(NO_LINE_BREAK)
  roleLabel!: string | null;
}

export class ReorderListingTeamDto {
  @IsArray()
  @ArrayMaxSize(LISTING_TEAM_LIMITS.acceptedPerListing)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  memberIds!: string[];
}

export class RequestListingTeamLinkDto {
  @IsUUID('all')
  listingId!: string;
}

export class ListingTeamPersonaSearchQuery {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/^@/, '') : value,
  )
  @IsString()
  @Length(
    LISTING_TEAM_SEARCH.queryMinLength,
    LISTING_TEAM_SEARCH.queryMaxLength,
  )
  q!: string;
}

export class ListingTeamListingSearchQuery {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(
    LISTING_TEAM_SEARCH.queryMinLength,
    LISTING_TEAM_SEARCH.queryMaxLength,
  )
  q!: string;
}
