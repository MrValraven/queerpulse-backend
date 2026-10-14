import { IsIn, IsOptional } from 'class-validator';
import {
  STUDIO_GENRES,
  STUDIO_MOODS,
  StudioGenre,
  StudioMood,
} from '../studio.constants';

/** Exactly one of the two; the service answers neither and both with 400
 *  `studio_radio_filter_required`, and a value outside its vocabulary is a
 *  plain 400 here. */
export class StudioRadioQuery {
  @IsOptional()
  @IsIn(STUDIO_GENRES)
  genre?: StudioGenre;

  @IsOptional()
  @IsIn(STUDIO_MOODS)
  mood?: StudioMood;
}
