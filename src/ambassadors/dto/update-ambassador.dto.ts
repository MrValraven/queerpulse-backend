import { IsIn } from 'class-validator';
import {
  AMBASSADOR_FOCUS_AREAS,
  type AmbassadorFocusArea,
} from '../ambassador-focus-areas';

/** Body for `PATCH /admin/ambassadors/:id`. */
export class UpdateAmbassadorDto {
  @IsIn(AMBASSADOR_FOCUS_AREAS)
  focusArea!: AmbassadorFocusArea;
}
