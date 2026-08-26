import { IsIn, IsOptional } from 'class-validator';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';
import {
  MOD_ACTION_CODES,
  ModActionCode,
} from '../../moderation/dto/mod-action.dto';

/**
 * `GET /mod/response-templates` query. Both filters are optional and
 * INCLUSIVE of the untargeted rows: asking for `reasonCode=harassment`
 * returns the harassment templates plus every template whose `reasonCode` is
 * NULL ("fits any reason"), because a general closing note is exactly as
 * applicable there as a keyed one. Omitting a filter returns everything
 * active.
 */
export class ListModResponseTemplatesQuery {
  @IsOptional()
  @IsIn(REASON_CODES)
  reasonCode?: ReasonCode;

  @IsOptional()
  @IsIn(MOD_ACTION_CODES)
  actionCode?: ModActionCode;
}
