import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

// One class covers both arms of the WorkLink union, same `@ValidateIf`-on-
// `kind` pattern as `OpenToEntryDto` (update-profile.dto.ts) — the irrelevant
// arm's fields stay unvalidated without being stripped from the whitelist, so
// `forbidNonWhitelisted` still rejects stray properties on an entry.
export class WorkLinkDto {
  @IsIn(['ref', 'external'])
  kind!: 'ref' | 'external';

  @ValidateIf((o: WorkLinkDto) => o.kind === 'ref')
  @IsString()
  entity?: string;

  @ValidateIf((o: WorkLinkDto) => o.kind === 'ref')
  @IsString()
  slug?: string;

  @ValidateIf((o: WorkLinkDto) => o.kind === 'external')
  @IsUrl()
  href?: string;
}

export class WorkItemDto {
  @IsString() @MaxLength(80) category!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(20) year!: string;
  @IsOptional() @IsImageReference() imageUrl?: string;

  // A full REPLACE of the pair, not a merge — consistent with the rest of this
  // DTO (and the whole `PUT /profiles/me/*` family): the caller resends the
  // entries it wants kept.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => WorkLinkDto)
  links?: WorkLinkDto[];
}

export class ReplaceWorkDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WorkItemDto)
  items!: WorkItemDto[];
}
