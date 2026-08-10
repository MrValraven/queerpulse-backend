import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class LineupEntryInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  memberSlug!: string;

  // Free-ish craft/role label, e.g. "dj"/"chef"/"performing" — not
  // constrained to `SubprofileKind`, see `EventLineupEntry`.
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  role!: string;
}

// `PUT /events/:slug/lineup` body — replaces the event's entire lineup.
export class PutLineupDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LineupEntryInputDto)
  entries!: LineupEntryInputDto[];
}
