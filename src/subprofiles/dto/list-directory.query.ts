import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { SubprofileKind } from '../entities/subprofile.entity';
import { AVAILABILITY_KEYS } from '../subprofile-validation';
import {
  TABLE_CHIP_FORMATS,
  TABLE_VIBES,
  type TableChipFormat,
  type TableVibe,
} from '../subprofile-table-summary';

// Sane paging defaults for the authenticated directory browse — replaces the
// old fixed `take: 5000` full-catalogue materialisation. `@Max` caps keep a
// hostile `?limit=999999` from pulling the whole table (plus its per-row
// social-count/tag/follower fan-out) into one response.
export const DIRECTORY_DEFAULT_LIMIT = 40;
export const DIRECTORY_MAX_LIMIT = 100;

/** How many tags one request may narrow by. The sidebar offers twenty at a
 *  time, and the vocabulary it keeps can grow as a member browses. */
const DIRECTORY_MAX_TAGS = 50;

/** Directory orders: by name (the server default), most recently updated, or
 *  most followed. */
export const DIRECTORY_SORTS = ['name', 'recent', 'followed'] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];
export const DIRECTORY_DEFAULT_SORT: DirectorySort = 'name';

// A single `?tags=x` and repeated `?tags=x&tags=y` both arrive here; the scalar
// case is coerced to a one-entry array (same shape as the housing browse's
// `areas`). Values travel as repeated params, because a member's tag may
// itself hold a comma.
const toArrayParam = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

export class ListSubprofileDirectoryQuery {
  // A fixed single-profession SCOPE for kind-scoped directories (the therapist
  // directory). It is part of the base set and is never lifted for a facet
  // count, unlike the sidebar's `kinds` below.
  @IsOptional() @IsEnum(SubprofileKind) kind?: SubprofileKind;

  @IsOptional() @IsString() @MaxLength(100) query?: string;

  // The sidebar's Profession chips: OR within the group, so `?kinds=poet&kinds=
  // illustrator` is "poets or illustrators".
  @IsOptional()
  @Transform(toArrayParam)
  @IsArray()
  @ArrayMaxSize(Object.values(SubprofileKind).length)
  @IsEnum(SubprofileKind, { each: true })
  kinds?: SubprofileKind[];

  // The sidebar's Tags chips: OR within the group, matched against the tags of
  // the persona's non-links items (the same items the card's tag row is read
  // from).
  @IsOptional()
  @Transform(toArrayParam)
  @IsArray()
  @ArrayMaxSize(DIRECTORY_MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

  // The Availability section's "Open to collabs" toggle sends
  // `open_to_collabs`; any stored availability key is accepted.
  @IsOptional() @IsIn(AVAILABILITY_KEYS) availability?: string;

  // Result order. Left out, the directory keeps its `name` order.
  @IsOptional() @IsIn(DIRECTORY_SORTS) sort?: DirectorySort;

  // "At the table" format chips (Quest personas): OR within the group, and a
  // stored `both` table matches either chip.
  @IsOptional()
  @Transform(toArrayParam)
  @IsArray()
  @ArrayMaxSize(TABLE_CHIP_FORMATS.length)
  @IsIn(TABLE_CHIP_FORMATS, { each: true })
  tableFormats?: TableChipFormat[];

  // "At the table" vibe chips: AND within the group, so a table must carry
  // every vibe picked.
  @IsOptional()
  @Transform(toArrayParam)
  @IsArray()
  @ArrayMaxSize(TABLE_VIBES.length)
  @IsIn(TABLE_VIBES, { each: true })
  tableVibes?: TableVibe[];

  // 1-based page index. `@Type` coerces the raw query string to a number before
  // the numeric validators run (the global ValidationPipe has `transform: true`
  // but query params arrive as strings).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DIRECTORY_MAX_LIMIT)
  limit?: number;
}
