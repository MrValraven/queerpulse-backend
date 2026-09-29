import { Transform } from 'class-transformer';
import { IsIn, IsString, Length } from 'class-validator';
import {
  AMBASSADOR_FOCUS_AREAS,
  type AmbassadorFocusArea,
} from '../ambassador-focus-areas';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Body for `POST /admin/ambassadors`. The reason is internal to staff. */
export class GrantAmbassadorDto {
  @IsString()
  @Transform(trimmed)
  @Length(1, 80)
  memberSlug!: string;

  @IsIn(AMBASSADOR_FOCUS_AREAS)
  focusArea!: AmbassadorFocusArea;

  @IsString()
  @Transform(trimmed)
  @Length(3, 500)
  reason!: string;
}
