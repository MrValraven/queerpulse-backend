import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { LandlordStatus } from '../entities/landlord.entity';

/**
 * `GET /admin/landlords` query (LOC-19).
 *
 * The route existed and returned one uncapped slab of every landlord ever
 * suggested, as public `LandlordCardDTO`s: no id to act on, no status, no
 * submitter and no page. That is not a console, which is a large part of why
 * nothing on the frontend ever called it. These three filters are the
 * questions a moderator opens the page asking: what is waiting on me
 * (`status=review`), where in Lisbon is it (`hood`), and is this one already
 * in here (`q`).
 */
export class ListAdminLandlordsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  /** The queue filter the console opens on. Omitted means every state. */
  @IsOptional()
  @IsEnum(LandlordStatus)
  status?: LandlordStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  hood?: string;

  /** Free-text match over the entry's name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
