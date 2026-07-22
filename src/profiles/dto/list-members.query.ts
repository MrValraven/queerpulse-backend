import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

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
}
