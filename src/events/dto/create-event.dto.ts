import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { EventStatus, EventVisibility } from '../entities/event.entity';

export class CreateEventDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) @MaxLength(10000) description!: string;
  @IsISO8601() startAt!: string;
  @IsOptional() @IsISO8601() endAt?: string;
  @IsTimeZone() timezone!: string;
  @IsOptional() @IsString() @MaxLength(300) venue?: string;
  @IsOptional() @IsBoolean() isOnline?: boolean;
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  onlineUrl?: string;
  @IsOptional() @IsInt() @Min(1) capacity?: number;
  // `EventVisibility.Community` is mutually exclusive with "no community":
  // enforced in `EventsService.create`/`update` (400), not here, because the
  // rule is cross-field (`communitySlug` below) and, on update, must weigh the
  // EXISTING `event.communityId` too (a patch can flip visibility without
  // resending `communitySlug`).
  @IsOptional() @IsEnum(EventVisibility) visibility?: EventVisibility;
  @IsOptional() @IsIn([EventStatus.Draft, EventStatus.Published]) status?:
    EventStatus.Draft | EventStatus.Published;
  @IsOptional() @IsImageReference() coverImageUrl?: string;
  // `string | null` (not just optional): on UPDATE, `null` (or `''`) is a
  // meaningful "detach the community" signal, distinct from omitting the
  // field entirely ("leave unchanged") — see `EventsService.update`.
  // `@IsOptional()` already treats `null` as "skip further validators"
  // (class-validator: empty === null || undefined), so a `null` payload
  // reaches the service untouched; a non-empty string still gets validated
  // as a normal slug. `create()` has no existing community to detach from,
  // so it treats `null`/`''`/absent identically (all "no community").
  @IsOptional()
  @IsString()
  @MaxLength(200)
  communitySlug?: string | null;
}
