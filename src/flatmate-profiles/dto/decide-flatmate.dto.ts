import { IsEnum } from 'class-validator';
import { FlatmateLikeDecision } from '../entities/flatmate-like.entity';

/** POST /flatmate-directory/:slug/decide body — a single like/pass from the
 * discovery deck. */
export class DecideFlatmateDto {
  @IsEnum(FlatmateLikeDecision) decision!: FlatmateLikeDecision;
}
