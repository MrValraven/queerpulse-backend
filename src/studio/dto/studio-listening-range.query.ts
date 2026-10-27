import { IsIn, IsOptional } from 'class-validator';
import {
  STUDIO_LISTENING_RANGES,
  StudioListeningRange,
} from '../studio-listening-history';

/** `GET /me/studio-listening` window: 4 weeks, 6 months or 12 months. */
export class StudioListeningRangeQuery {
  @IsOptional()
  @IsIn(STUDIO_LISTENING_RANGES)
  range?: StudioListeningRange;
}
