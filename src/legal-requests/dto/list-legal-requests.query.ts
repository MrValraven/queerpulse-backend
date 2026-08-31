import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import {
  LegalRequestOutcome,
  LegalRequestType,
} from '../legal-request-vocabulary';

/**
 * Which slice of the register `GET /admin/legal-requests` should serve.
 *
 * `all` is the default on purpose. A voided record is still part of the
 * register's history, and a queue that hides voided rows by default would let
 * a record be struck and then be hard to find again, which is the failure the
 * void-instead-of-delete rule exists to prevent.
 */
export const LEGAL_REQUEST_REGISTER_STATES = [
  'all',
  'active',
  'voided',
] as const;

export type LegalRequestRegisterState =
  (typeof LEGAL_REQUEST_REGISTER_STATES)[number];

export class ListLegalRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsIn(LEGAL_REQUEST_REGISTER_STATES)
  state?: LegalRequestRegisterState;

  @IsOptional()
  @IsEnum(LegalRequestType)
  requestType?: LegalRequestType;

  @IsOptional()
  @IsEnum(LegalRequestOutcome)
  outcome?: LegalRequestOutcome;
}
