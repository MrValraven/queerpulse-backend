import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EventStatus, EventVisibility } from '../entities/event.entity';

export class CreateEventDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsString() @MinLength(1) @MaxLength(10000) description: string;
  @IsISO8601() startAt: string;
  @IsOptional() @IsISO8601() endAt?: string;
  @IsString() @MaxLength(60) timezone: string;
  @IsOptional() @IsString() @MaxLength(300) venue?: string;
  @IsOptional() @IsBoolean() isOnline?: boolean;
  @IsOptional() @IsString() @MaxLength(500) onlineUrl?: string;
  @IsOptional() @IsInt() @Min(1) capacity?: number;
  @IsOptional() @IsEnum(EventVisibility) visibility?: EventVisibility;
  @IsOptional() @IsIn([EventStatus.Draft, EventStatus.Published]) status?: EventStatus.Draft | EventStatus.Published;
  @IsOptional() @IsString() @MaxLength(500) coverImageUrl?: string;
}
