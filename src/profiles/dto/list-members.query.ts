import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Directory sort orders. The directory is paginated, so the ordering MUST be
 * applied server-side — a client can only ever see one page and cannot reorder
 * across the whole set. There is no "recently active" option: the platform
 * tracks no last-active timestamp, so it can't be honoured (see the frontend's
 * SortKey, which drops it for the same reason).
 */
export enum MemberSort {
  RecentlyJoined = 'recentlyJoined',
  ClosestMutuals = 'closestMutuals',
  AToZ = 'aToZ',
  MostVouched = 'mostVouched',
}

export class ListMembersQuery {
  @IsOptional() @IsString() query?: string;

  // comma-separated SKILLS, e.g. ?tags=Illustration,NestJS. Filters
  // `profiles.tags`, which holds craft/skill words — NOT identities. This is a
  // legitimate filter and is left exactly as it was.
  @IsOptional() @IsString() tags?: string;

  // comma-separated directory identity FACETS, e.g. ?identities=lesbian,qpoc.
  // A separate param from `tags` on purpose: they are different vocabularies
  // over different columns, and folding identities into `tags` (which the
  // frontend used to do) is what made this filter silently return nothing.
  //
  // Filters `profiles.discoverable_identities` — the opt-in published subset —
  // never `profiles.identities`. Accepted values are range-checked in the
  // service against DIRECTORY_IDENTITY_FACETS.
  @IsOptional() @IsString() identities?: string;

  // Directory sort order; defaults to RecentlyJoined when omitted.
  @IsOptional() @IsEnum(MemberSort) sort?: MemberSort;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;

  // comma-separated "open to" PRESET ids, e.g. ?openTo=mentoring,swaps. Custom
  // (freeform) entries are never filterable — see open-to.ts. Filters
  // `profiles.open_to`, a jsonb array, via a preset-membership EXISTS check
  // (see ProfilesService.searchMembers) rather than the `&&` overlap the
  // plain-array facets below use.
  @IsOptional() @IsString() openTo?: string;

  // comma-separated neighbourhood names, e.g. ?hoods=Anjos,Mouraria. Matched
  // against the free-text `profiles.location` via substring test — see
  // src/profiles/neighbourhoods.ts. Unknown names are dropped before the
  // query runs.
  @IsOptional() @IsString() hoods?: string;

  // comma-separated discipline ids, e.g. ?disciplines=design,tech. Filters
  // `profiles.discipline`. See src/profiles/professions.ts.
  @IsOptional() @IsString() disciplines?: string;

  // comma-separated profession ids, e.g. ?professions=graphicDesigner. Filters
  // `profiles.profession`. See src/profiles/professions.ts.
  @IsOptional() @IsString() professions?: string;

  // comma-separated language codes, e.g. ?languages=PT,EN. Filters
  // `profiles.languages`. See src/profiles/languages.ts.
  @IsOptional() @IsString() languages?: string;

  // Years-on-QueerPulse range, both inclusive. Either bound may be sent
  // alone. Computed from `profiles.joined_at` at query time — there is no
  // stored "tenure" column.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) yearsFrom?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(200) yearsTo?: number;
}
